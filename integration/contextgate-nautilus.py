"""
Nautilus 右键菜单插件
在文件管理器中右键点击文件夹时显示 "Open with ContextGate"
"""

import os
import subprocess
from urllib.parse import unquote

try:
    from gi.repository import Nautilus, GObject
except ImportError:
    Nautilus = None
    GObject = None


class ContextGateExtension(GObject.GObject, Nautilus.MenuProvider):
    """ContextGate Nautilus 扩展"""
    
    def __init__(self):
        super().__init__()
    
    def _open_with_contextgate(self, menu_item, folder_path):
        """使用 ContextGate 打开文件夹"""
        subprocess.Popen(
            ['contextgate', 'build', folder_path],
            start_new_session=True
        )
        subprocess.Popen(
            ['contextgate', 'gui'],
            start_new_session=True
        )
    
    def get_file_items(self, files):
        """返回文件右键菜单项"""
        if not files or len(files) != 1:
            return []
        
        file = files[0]
        
        if not file.is_directory():
            return []
        
        folder_path = unquote(file.get_uri()[7:])
        
        item = Nautilus.MenuItem(
            name="ContextGate::open_with",
            label="Open with ContextGate",
            tip="Build context and start proxy for this folder"
        )
        
        item.connect("activate", self._open_with_contextgate, folder_path)
        
        return [item]
    
    def get_background_items(self, folder):
        """返回背景右键菜单项"""
        return []


if Nautilus is not None:
    pass
