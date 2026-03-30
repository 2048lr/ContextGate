"""
ContextGate - 程序入口
CLI 控制台 + GUI 模式
支持热重载、多后端路由、完整监控
支持多项目适配、GUI选择器、智能端口避让
支持 PySide6 桌面界面
"""

import argparse
import sys
import os
import threading
import time
import signal
from pathlib import Path
from datetime import datetime

from app.scanner import CodeScanner
from app.proxy import AIProxy, ProxyMonitor, ConfigManager
from app.monitor import TokenMonitor
from app.report import show_stats, show_savings


from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.live import Live
from rich.layout import Layout
from rich.text import Text


console = Console()
context_update_event = threading.Event()
shutdown_event = threading.Event()


last_context_update = {"time": None, "hash": None, "files": 0, "tokens": 0}
actual_port = 8080


def main():
    parser = argparse.ArgumentParser(
        description="ContextGate - AI Context Management & Proxy System"
    )
    
    subparsers = parser.add_subparsers(dest="command", help="可用命令")
    
    gui_parser = subparsers.add_parser("gui", help="启动图形界面 (推荐)")
    gui_parser.add_argument("--config", default="config.yaml", help="配置文件路径")
    gui_parser.add_argument("--port", type=int, default=8000, help="代理端口 (默认8000)")
    gui_parser.add_argument("--debug", action="store_true", help="启用调试模式")
    
    build_parser = subparsers.add_parser("build", help="构建完整上下文文件")
    build_parser.add_argument("path", nargs="?", default=None, help="项目路径 (可选，不指定则使用当前工作空间)")
    build_parser.add_argument("--output", "-o", default=None, help="输出文件路径 (可选，默认在项目目录下生成)")
    build_parser.add_argument("--config", default="config.yaml", help="配置文件路径")
    
    serve_parser = subparsers.add_parser("serve", help="启动代理服务器和监控界面 (TUI)")
    serve_parser.add_argument("path", nargs="?", default=None, help="项目路径 (可选，不指定则使用当前工作空间)")
    serve_parser.add_argument("--host", default="127.0.0.1", help="监听地址")
    serve_parser.add_argument("--port", type=int, default=8000, help="监听端口 (默认8000，被占用则自动切换)")
    serve_parser.add_argument("--base-url", default=None, help="目标 API Base URL (可选，使用 config.yaml)")
    serve_parser.add_argument("--api-key", default=None, help="API Key (可选，使用 config.yaml)")
    serve_parser.add_argument("--context", default=None, help="上下文文件路径 (可选，自动从工作空间获取)")
    serve_parser.add_argument("--budget", type=float, default=None, help="预算上限 (美元)")
    serve_parser.add_argument("--config", default="config.yaml", help="配置文件路径")
    
    select_parser = subparsers.add_parser("select", help="通过 GUI 选择项目目录")
    select_parser.add_argument("--config", default="config.yaml", help="配置文件路径")
    
    stats_parser = subparsers.add_parser("stats", help="显示使用统计")
    stats_parser.add_argument("--period", choices=["week", "month", "year", "all"], default="week", help="统计周期")
    stats_parser.add_argument("--db", default="contextgate.db", help="数据库路径")
    
    scan_parser = subparsers.add_parser("scan", help="扫描项目代码")
    scan_parser.add_argument("path", help="项目路径")
    scan_parser.add_argument("--output", "-o", help="输出文件路径")
    
    args = parser.parse_args()
    
    if args.command == "gui":
        handle_gui(args)
    elif args.command == "build":
        handle_build(args)
    elif args.command == "serve":
        handle_serve(args)
    elif args.command == "select":
        handle_select(args)
    elif args.command == "stats":
        handle_stats(args)
    elif args.command == "scan":
        handle_scan(args)
    else:
        parser.print_help()
        sys.exit(1)


def handle_gui(args):
    """处理 gui 命令 - 启动图形界面"""
    if args.debug:
        import os
        os.environ['CONTEXTGATE_DEBUG'] = '1'
        print("[DEBUG] 启动调试模式...")
        print(f"[DEBUG] Python 路径: {sys.path}")
        print(f"[DEBUG] 当前目录: {os.getcwd()}")
    
    try:
        from app.gui import run_gui
        run_gui(args.config)
    except ImportError as e:
        console.print(f"[red]错误: 无法启动图形界面[/]")
        console.print(f"[dim]原因: {e}[/]")
        
        if args.debug:
            import traceback
            traceback.print_exc()
        
        console.print(f"\n[yellow]请安装 PySide6:[/]")
        console.print(f"  pip install PySide6")
        console.print(f"\n[dim]或使用 TUI 模式: gate serve[/]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]错误: {e}[/]")
        if args.debug:
            import traceback
            traceback.print_exc()
        sys.exit(1)


def handle_build(args):
    """处理 build 命令"""
    config_manager = ConfigManager(args.config)
    
    if args.path:
        project_path = Path(args.path).resolve()
    else:
        workspace = config_manager.get_workspace()
        if workspace:
            project_path = Path(workspace).resolve()
        else:
            console.print("[yellow]未指定项目路径，使用当前目录[/]")
            project_path = Path.cwd()
    
    output_path = args.output
    
    console.print(Panel.fit(
        "[bold cyan]ContextGate Build[/]",
        border_style="cyan"
    ))
    
    console.print(f"\n[green]扫描目录:[/] {project_path}")
    if output_path:
        console.print(f"[green]输出文件:[/] {output_path}\n")
    else:
        console.print(f"[green]输出文件:[/] {project_path}/full_context.txt\n")
    
    scanner = CodeScanner(str(project_path))
    
    with console.status("[bold blue]正在扫描文件...[/]"):
        files = scanner.scan()
    
    console.print(f"[green]发现 {len(files)} 个文件[/]\n")
    
    with console.status("[bold blue]正在构建上下文...[/]"):
        file_count, total_chars, estimated_tokens, actual_output = scanner.build_context(output_path)
    
    output_size = os.path.getsize(actual_output)
    
    console.print(Panel(
        f"[green]文件数量:[/] {file_count}\n"
        f"[green]总字符数:[/] {total_chars:,}\n"
        f"[green]预估Token:[/] {estimated_tokens:,}\n"
        f"[green]输出大小:[/] {format_size(output_size)}\n"
        f"[green]输出路径:[/] {actual_output}",
        title="[bold]构建完成[/]",
        border_style="green"
    ))
    
    check_golden_standard(output_size, estimated_tokens)


def handle_select(args):
    """处理 select 命令 - 通过 GUI 选择项目目录"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        
        console.print(Panel.fit(
            "[bold cyan]ContextGate 项目选择器[/]",
            border_style="cyan"
        ))
        console.print("\n[yellow]请在弹出的对话框中选择项目目录...[/]\n")
        
        selected_path = filedialog.askdirectory(
            title="选择项目根目录"
        )
        
        root.destroy()
        
        if selected_path:
            config_manager = ConfigManager(args.config)
            config_manager.set_workspace(selected_path)
            
            console.print(f"[green]已选择项目:[/] [bold]{selected_path}[/]")
            console.print(f"[green]已设置为当前工作空间[/]")
            
            context_file = Path(selected_path) / "full_context.txt"
            console.print(f"\n[cyan]提示:[/] 运行 [bold]gate build[/] 生成上下文文件")
            console.print(f"[cyan]提示:[/] 运行 [bold]gate serve[/] 启动代理服务器")
        else:
            console.print("[yellow]未选择目录，操作已取消[/]")
    
    except ImportError:
        console.print("[red]错误: tkinter 未安装。请安装 python3-tk 包[/]")
        console.print("[dim]Ubuntu/Debian: sudo apt-get install python3-tk[/]")
        console.print("[dim]Fedora: sudo dnf install python3-tkinter[/]")
    except Exception as e:
        console.print(f"[red]错误: {e}[/]")


def handle_serve(args):
    """处理 serve 命令 - 启动代理服务器和 TUI 监控界面"""
    global actual_port
    
    config_manager = ConfigManager(args.config)
    
    if args.path:
        project_path = Path(args.path).resolve()
    else:
        workspace = config_manager.get_workspace()
        if workspace:
            project_path = Path(workspace).resolve()
        else:
            console.print("[yellow]未指定项目路径，使用当前目录[/]")
            project_path = Path.cwd()
    
    context_file = args.context
    if context_file is None:
        context_file = str(project_path / "full_context.txt")
    
    console.print(Panel.fit(
        "[bold cyan]ContextGate Proxy Server[/bold cyan]\n"
        f"Version 0.3.0 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        border_style="cyan"
    ))
    
    console.print(f"\n[green]项目路径:[/] [bold]{project_path}[/]")
    console.print(f"[green]上下文文件:[/] [bold]{context_file}[/]")
    console.print(f"[green]配置文件:[/] [bold]{args.config}[/]")
    console.print(f"[green]尝试端口:[/] [bold]{args.port}[/] (若被占用将自动切换)")
    if args.budget:
        console.print(f"[green]预算上限:[/] [bold]${args.budget:.2f}[/]")
    console.print()
    
    proxy_monitor = ProxyMonitor.get_instance()
    token_monitor = TokenMonitor(budget_limit=args.budget)
    
    scanner = CodeScanner(str(project_path))
    scanner.build_context(context_file)
    
    def on_context_update(data):
        global last_context_update
        last_context_update = {
            "time": data.get("timestamp"),
            "hash": data.get("hash"),
            "files": data.get("file_count", 0),
            "tokens": data.get("tokens", 0)
        }
        context_update_event.set()
        console.print(f"\n[bold green]Context Updated![/] (Hash: {data.get('hash', 'N/A')})\n")
    
    scanner.set_on_update_callback(on_context_update)
    scanner.start_watcher(output_path=context_file)
    
    def on_request_callback(data):
        token_monitor.record_usage(
            input_tokens=data.get("input_tokens", 0),
            output_tokens=data.get("output_tokens", 0),
            model=data.get("model", "unknown"),
            cache_hit=data.get("cache_hit", False)
        )
    
    proxy_monitor.on_request = on_request_callback
    
    proxy = AIProxy(
        base_url=args.base_url,
        api_key=args.api_key,
        context_file=context_file,
        config_path=args.config
    )
    
    def run_proxy():
        global actual_port
        actual_port, _ = proxy.run(host=args.host, port=args.port)
    
    proxy_thread = threading.Thread(target=run_proxy, daemon=True)
    proxy_thread.start()
    
    time.sleep(0.5)
    
    console.print(f"\n[bold green]代理服务器已启动![/]")
    console.print(f"[bold yellow]>>> 实际端口: {actual_port} <<<[/]")
    console.print(f"[dim]Goose BaseURL: http://{args.host}:{actual_port}[/]")
    console.print("[dim]按 Ctrl+C 停止服务器[/]\n")
    
    def build_display():
        layout = Layout()
        
        layout.split(
            Layout(name="header", size=3),
            Layout(name="stats", size=8),
            Layout(name="context", size=4),
            Layout(name="requests", size=6),
            Layout(name="footer", size=2)
        )
        
        header = Panel(
            f"[bold yellow on red] ★ 端口: {actual_port} ★ [/] | "
            f"[bold cyan]ContextGate[/] | "
            f"BaseURL: http://{args.host}:{actual_port} | "
            f"{datetime.now().strftime('%H:%M:%S')}",
            style="bold white on blue"
        )
        layout["header"].update(header)
        
        cache_stats = proxy_monitor.cache_manager
        token_summary = token_monitor.get_summary()
        
        stats_table = Table(show_header=False, box=None, expand=True)
        stats_table.add_column("指标", style="cyan")
        stats_table.add_column("值", justify="right")
        
        stats_table.add_row("总请求数", f"[bold]{cache_stats.total_requests}[/]")
        stats_table.add_row("缓存命中", f"[bold green]{cache_stats.cache_hits}[/]")
        stats_table.add_row("命中率", f"[bold]{cache_stats.get_hit_rate():.1f}%[/]")
        stats_table.add_row("总 Token", f"[bold]{token_summary['total_tokens']['total_tokens']:,}[/]")
        stats_table.add_row("总费用", f"[bold yellow]${token_summary['total_cost']:.4f}[/]")
        
        layout["stats"].update(Panel(stats_table, title="[bold]统计信息[/]", border_style="green"))
        
        ctx_info = last_context_update
        ctx_text = Text()
        if ctx_info["time"]:
            ctx_text.append(f"最后更新: {ctx_info['time'].strftime('%H:%M:%S')}\n", style="green")
            ctx_text.append(f"Hash: {ctx_info['hash']}\n", style="dim")
            ctx_text.append(f"文件数: {ctx_info['files']} | Tokens: {ctx_info['tokens']:,}", style="cyan")
        else:
            ctx_text.append("等待更新...", style="dim")
        
        layout["context"].update(Panel(ctx_text, title="[bold]上下文状态[/]", border_style="blue"))
        
        requests_table = Table(show_header=True, box=None, expand=True)
        requests_table.add_column("时间", style="dim", width=8)
        requests_table.add_column("模型", width=18)
        requests_table.add_column("Token", justify="right", width=10)
        requests_table.add_column("费用", justify="right", width=8)
        requests_table.add_column("缓存", width=6)
        
        recent_requests = token_monitor.usage_history[-4:]
        for req in reversed(recent_requests):
            cache_status = "[green]HIT[/]" if req.cache_hit else "[yellow]MISS[/]"
            requests_table.add_row(
                req.timestamp.strftime("%H:%M:%S"),
                req.model[:18],
                f"{req.total_tokens:,}",
                f"${req.cost:.4f}",
                cache_status
            )
        
        layout["requests"].update(Panel(requests_table, title="[bold]最近请求[/]", border_style="yellow"))
        
        footer = Text()
        footer.append("按 ", style="dim")
        footer.append("Ctrl+C", style="bold red")
        footer.append(" 停止 | ", style="dim")
        footer.append(f"Goose BaseURL: http://{args.host}:{actual_port}", style="bold yellow")
        layout["footer"].update(footer)
        
        return layout
    
    def signal_handler(sig, frame):
        shutdown_event.set()
        console.print("\n\n[yellow]正在停止服务器...[/]")
        scanner.stop_watcher()
        console.print("[green]服务器已停止[/]")
        
        if token_monitor.usage_history:
            report_file = f"usage_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            token_monitor.export_report(report_file)
            console.print(f"[green]使用报告已保存: {report_file}[/]")
        
        os._exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    
    try:
        with Live(build_display(), console=console, refresh_per_second=2, screen=False):
            while not shutdown_event.is_set():
                if context_update_event.is_set():
                    context_update_event.clear()
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass


def handle_stats(args):
    """处理 stats 命令"""
    console.print(Panel.fit(
        "[bold cyan]ContextGate 使用统计[/]",
        border_style="cyan"
    ))
    console.print()
    
    show_stats(args.period, args.db)
    console.print()
    
    show_savings(args.db)


def handle_scan(args):
    """处理扫描命令"""
    console.print(f"[cyan]正在扫描项目:[/] {args.path}")
    
    scanner = CodeScanner(args.path)
    files = scanner.scan()
    
    console.print(f"\n[green]扫描完成，找到 {len(files)} 个文件:[/]")
    for i, f in enumerate(files[:30], 1):
        console.print(f"  {i}. {f}")
    
    if len(files) > 30:
        console.print(f"  ... 还有 {len(files) - 30} 个文件")
    
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            for file_path in files:
                f.write(f"{file_path}\n")
        console.print(f"\n[green]结果已保存到: {args.output}[/]")


def format_size(size: int) -> str:
    """格式化文件大小"""
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size:.2f} TB"


def check_golden_standard(size: int, tokens: int) -> None:
    """检查是否符合黄金源码包标准"""
    console.print("\n[bold]黄金源码包标准检查:[/]")
    
    KB = 1024
    MB = 1024 * KB
    
    checks = []
    
    if size < 50 * KB:
        checks.append(("文件大小 < 50KB", True, f"{format_size(size)} ✓"))
    elif size < 100 * KB:
        checks.append(("文件大小 < 100KB", True, f"{format_size(size)} ✓"))
    elif size < 500 * KB:
        checks.append(("文件大小 < 500KB", True, f"{format_size(size)} ✓"))
    elif size < 1 * MB:
        checks.append(("文件大小 < 1MB", True, f"{format_size(size)} ✓"))
    else:
        checks.append(("文件大小", False, f"{format_size(size)} - 建议精简"))
    
    if tokens < 10000:
        checks.append(("Token数 < 10K", True, f"{tokens:,} tokens ✓"))
    elif tokens < 50000:
        checks.append(("Token数 < 50K", True, f"{tokens:,} tokens ✓"))
    elif tokens < 100000:
        checks.append(("Token数 < 100K", True, f"{tokens:,} tokens ✓"))
    elif tokens < 200000:
        checks.append(("Token数 < 200K", True, f"{tokens:,} tokens ⚠️"))
    else:
        checks.append(("Token数", False, f"{tokens:,} tokens - 建议精简"))
    
    all_passed = True
    for name, passed, detail in checks:
        status = "✓ PASS" if passed else "✗ FAIL"
        console.print(f"  [{status}] {name}: {detail}")
        if not passed:
            all_passed = False
    
    if all_passed:
        console.print("\n[green]结论: 符合黄金源码包标准 ✓[/]")
    else:
        console.print("\n[yellow]结论: 建议进一步精简代码[/]")


if __name__ == "__main__":
    main()
