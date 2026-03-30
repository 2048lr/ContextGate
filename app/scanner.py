"""
任务 1：代码扫描与 .gitignore 处理
负责扫描项目代码并处理 .gitignore 规则
支持递归查找父目录的 .gitignore 文件
支持 watchdog 热重载监控
"""

import os
import re
import threading
import time
from pathlib import Path
from typing import List, Dict, Tuple, Optional, Callable, Set
from dataclasses import dataclass, field
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor


@dataclass
class IgnoreRule:
    pattern: str
    is_negative: bool = False
    is_directory: bool = False
    base_path: Path = field(default_factory=lambda: Path.cwd())


class GitIgnoreParser:
    """.gitignore 解析器"""
    
    def __init__(self):
        self.rules: List[IgnoreRule] = []
    
    def parse_file(self, gitignore_path: Path) -> None:
        if not gitignore_path.exists():
            return
        
        base_path = gitignore_path.parent
        
        with open(gitignore_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.rstrip('\n\r')
                
                if not line or line.startswith('#'):
                    continue
                
                is_negative = line.startswith('!')
                if is_negative:
                    line = line[1:]
                
                is_directory = line.endswith('/')
                if is_directory:
                    line = line[:-1]
                
                if line.startswith('\\'):
                    line = line[1:]
                
                self.rules.append(IgnoreRule(
                    pattern=line,
                    is_negative=is_negative,
                    is_directory=is_directory,
                    base_path=base_path
                ))
    
    def _pattern_to_regex(self, pattern: str, base_path: Path, for_dir: bool = False) -> re.Pattern:
        regex = ""
        i = 0
        n = len(pattern)
        
        has_leading_slash = pattern.startswith('/')
        if has_leading_slash:
            pattern = pattern[1:]
            n = len(pattern)
        
        while i < n:
            c = pattern[i]
            
            if c == '*':
                if i + 1 < n and pattern[i + 1] == '*':
                    if i + 2 < n and pattern[i + 2] == '/':
                        regex += "(.*)"
                        i += 3
                        continue
                    else:
                        regex += "(.*)"
                        i += 2
                        continue
                else:
                    regex += "([^/]*)"
                    i += 1
            elif c == '?':
                regex += "([^/])"
                i += 1
            elif c == '[':
                j = i + 1
                if j < n and pattern[j] == '!':
                    j += 1
                if j < n and pattern[j] == ']':
                    j += 1
                while j < n and pattern[j] != ']':
                    j += 1
                if j >= n:
                    regex += "\\["
                    i += 1
                else:
                    bracket_content = pattern[i+1:j]
                    regex += f"([{bracket_content}])"
                    i = j + 1
            elif c in '.^$+{}|()':
                regex += '\\' + c
                i += 1
            elif c == '/':
                regex += '/'
                i += 1
            else:
                regex += c
                i += 1
        
        if has_leading_slash:
            full_regex = "^" + regex
        else:
            full_regex = "(^|.*/)" + regex
        
        if for_dir or pattern.endswith('/'):
            full_regex += "(/.*)?"
        else:
            full_regex += "(/.*)?"
        
        full_regex += "$"
        
        return re.compile(full_regex)
    
    def is_ignored(self, path: Path, relative_to: Path) -> Tuple[bool, Optional[Path]]:
        try:
            rel_path = path.relative_to(relative_to)
        except ValueError:
            return False, None
        
        rel_str = str(rel_path).replace(os.sep, '/')
        is_dir = path.is_dir()
        
        result = False
        matched_base = None
        
        for rule in self.rules:
            try:
                test_path = path
                try:
                    test_rel = test_path.relative_to(rule.base_path)
                    test_str = str(test_rel).replace(os.sep, '/')
                except ValueError:
                    continue
                
                pattern = rule.pattern
                
                if '/' in pattern or pattern.startswith('**'):
                    regex = self._pattern_to_regex(pattern, rule.base_path, is_dir)
                    match_target = test_str
                else:
                    regex = self._pattern_to_regex(pattern, rule.base_path, is_dir)
                    match_target = test_str
                
                if is_dir:
                    match_target = match_target + '/'
                
                if regex.search(match_target) or regex.search(test_str):
                    if not rule.is_negative:
                        result = True
                        matched_base = rule.base_path
                    else:
                        result = False
                        matched_base = None
            except Exception:
                continue
        
        return result, matched_base


class CodeScanner:
    """代码扫描器，支持递归查找父目录的 .gitignore 规则"""
    
    DEFAULT_IGNORE_PATTERNS = [
        ".git",
        "__pycache__",
        "*.pyc",
        "*.pyo",
        ".DS_Store",
        "node_modules",
        ".venv",
        "venv",
        ".env",
        "*.egg-info",
        "dist",
        "build",
        ".idea",
        ".vscode",
        "*.swp",
        "*.swo",
        "*~",
        "full_context.txt",
        "*.db",
        "*.sqlite",
    ]
    
    WATCH_EXTENSIONS = {
        '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs',
        '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift',
        '.kt', '.scala', '.md', '.txt', '.json', '.yaml', '.yml',
        '.toml', '.ini', '.cfg', '.env', '.sh', '.bash', '.zsh',
    }
    
    def __init__(self, project_path: str = "."):
        self.project_path = Path(project_path).resolve()
        self.parser = GitIgnoreParser()
        self._load_all_gitignores()
        self._add_default_ignores()
        self._watcher_thread: Optional[threading.Thread] = None
        self._stop_watcher = threading.Event()
        self._on_update_callback: Optional[Callable] = None
        self._last_update_time: Optional[datetime] = None
        self._context_hash: Optional[str] = None
    
    def _load_all_gitignores(self) -> None:
        """递归查找并加载所有 .gitignore 文件"""
        gitignore_files = []
        
        current = self.project_path
        while True:
            gitignore = current / ".gitignore"
            if gitignore.exists():
                gitignore_files.append(gitignore)
            
            parent = current.parent
            if parent == current:
                break
            current = parent
        
        gitignore_files.reverse()
        
        for gitignore in gitignore_files:
            self.parser.parse_file(gitignore)
        
        for root, dirs, files in os.walk(self.project_path):
            root_path = Path(root)
            for filename in files:
                if filename == ".gitignore":
                    gitignore_path = root_path / filename
                    if gitignore_path not in gitignore_files:
                        self.parser.parse_file(gitignore_path)
    
    def _add_default_ignores(self) -> None:
        """添加默认忽略规则"""
        for pattern in self.DEFAULT_IGNORE_PATTERNS:
            self.parser.rules.append(IgnoreRule(
                pattern=pattern,
                is_negative=False,
                base_path=self.project_path
            ))
    
    def _is_ignored(self, path: Path) -> bool:
        """检查路径是否应该被忽略"""
        is_ignored, _ = self.parser.is_ignored(path, self.project_path)
        return is_ignored
    
    def scan(self) -> List[Path]:
        """扫描项目目录，返回所有未被忽略的文件"""
        files: List[Path] = []
        
        for root, dirs, filenames in os.walk(self.project_path):
            root_path = Path(root)
            
            dirs_to_remove = []
            for d in dirs:
                dir_path = root_path / d
                if self._is_ignored(dir_path):
                    dirs_to_remove.append(d)
            
            for d in dirs_to_remove:
                dirs.remove(d)
            
            for filename in filenames:
                file_path = root_path / filename
                if not self._is_ignored(file_path):
                    files.append(file_path)
        
        return files
    
    def get_file_content(self, file_path: Path) -> Optional[str]:
        """读取文件内容"""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return f.read()
        except (UnicodeDecodeError, IOError, PermissionError):
            return None
    
    def build_context(self, output_path: str = None) -> Tuple[int, int, int, str]:
        """
        构建完整上下文文件
        如果 output_path 为 None，则在项目目录下生成 full_context.txt
        返回: (文件数量, 总字符数, 预估Token数, 实际输出路径)
        """
        if output_path is None:
            output_path = str(self.project_path / "full_context.txt")
        
        files = self.scan()
        
        total_chars = 0
        file_count = 0
        
        import hashlib
        content_hash = hashlib.md5()
        
        with open(output_path, "w", encoding="utf-8") as out:
            out.write("=" * 80 + "\n")
            out.write("FULL CONTEXT - Generated by ContextGate\n")
            out.write(f"Generated at: {datetime.now().isoformat()}\n")
            out.write("=" * 80 + "\n\n")
            
            for file_path in sorted(files):
                content = self.get_file_content(file_path)
                if content is None:
                    continue
                
                try:
                    rel_path = file_path.relative_to(self.project_path)
                except ValueError:
                    rel_path = file_path
                
                out.write("-" * 80 + "\n")
                out.write(f"FILE: {rel_path}\n")
                out.write("-" * 80 + "\n")
                out.write(content)
                if not content.endswith('\n'):
                    out.write('\n')
                out.write('\n')
                
                content_hash.update(content.encode())
                total_chars += len(content)
                file_count += 1
        
        self._context_hash = content_hash.hexdigest()[:12]
        self._last_update_time = datetime.now()
        
        estimated_tokens = total_chars // 4
        
        return file_count, total_chars, estimated_tokens, output_path
    
    def get_context_hash(self) -> Optional[str]:
        """获取当前上下文哈希"""
        return self._context_hash
    
    def get_last_update_time(self) -> Optional[datetime]:
        """获取最后更新时间"""
        return self._last_update_time
    
    def set_on_update_callback(self, callback: Callable) -> None:
        """设置上下文更新回调函数"""
        self._on_update_callback = callback
    
    def start_watcher(self, output_path: str = "full_context.txt", debounce_seconds: float = 1.0) -> None:
        """启动文件监控器"""
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler, FileSystemEvent
        except ImportError:
            print("[Warning] watchdog not installed, hot reload disabled")
            return
        
        scanner = self
        
        class FileChangeHandler(FileSystemEventHandler):
            def __init__(self):
                self._pending_update = False
                self._last_change = 0
                self._changed_files: Set[str] = set()
            
            def on_modified(self, event: FileSystemEvent):
                if event.is_directory:
                    return
                
                path = Path(event.src_path)
                
                if path.suffix.lower() not in scanner.WATCH_EXTENSIONS:
                    return
                
                if scanner._is_ignored(path):
                    return
                
                self._changed_files.add(str(path))
                self._pending_update = True
                self._last_change = time.time()
            
            def on_created(self, event: FileSystemEvent):
                if event.is_directory:
                    return
                
                path = Path(event.src_path)
                
                if path.suffix.lower() not in scanner.WATCH_EXTENSIONS:
                    return
                
                if scanner._is_ignored(path):
                    return
                
                self._changed_files.add(str(path))
                self._pending_update = True
                self._last_change = time.time()
            
            def on_deleted(self, event: FileSystemEvent):
                if event.is_directory:
                    return
                
                path = Path(event.src_path)
                
                if path.suffix.lower() not in scanner.WATCH_EXTENSIONS:
                    return
                
                self._pending_update = True
                self._last_change = time.time()
            
            def should_update(self) -> bool:
                if not self._pending_update:
                    return False
                
                if time.time() - self._last_change >= debounce_seconds:
                    self._pending_update = False
                    return True
                
                return False
        
        handler = FileChangeHandler()
        observer = Observer()
        observer.schedule(handler, str(self.project_path), recursive=True)
        observer.start()
        
        def watcher_loop():
            while not scanner._stop_watcher.is_set():
                if handler.should_update():
                    old_hash = scanner._context_hash
                    
                    try:
                        file_count, total_chars, tokens, actual_path = scanner.build_context(output_path)
                        
                        if scanner._on_update_callback:
                            scanner._on_update_callback({
                                "type": "context_updated",
                                "timestamp": datetime.now(),
                                "file_count": file_count,
                                "total_chars": total_chars,
                                "tokens": tokens,
                                "hash": scanner._context_hash,
                                "changed_files": list(handler._changed_files)
                            })
                        
                        handler._changed_files.clear()
                    except Exception as e:
                        if scanner._on_update_callback:
                            scanner._on_update_callback({
                                "type": "update_error",
                                "error": str(e)
                            })
                
                time.sleep(0.5)
            
            observer.stop()
            observer.join()
        
        self._watcher_thread = threading.Thread(target=watcher_loop, daemon=True)
        self._watcher_thread.start()
    
    def stop_watcher(self) -> None:
        """停止文件监控器"""
        self._stop_watcher.set()
        if self._watcher_thread:
            self._watcher_thread.join(timeout=2.0)
            self._watcher_thread = None
