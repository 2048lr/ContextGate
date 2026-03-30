"""
深色主题样式表
"""

DARK_THEME = """
QMainWindow {
    background-color: #1e1e1e;
}

QWidget {
    background-color: #1e1e1e;
    color: #cccccc;
    font-family: 'Segoe UI', 'Ubuntu', 'Noto Sans', sans-serif;
    font-size: 13px;
}

QMenuBar {
    background-color: #2d2d2d;
    color: #cccccc;
    padding: 4px;
}

QMenuBar::item {
    padding: 4px 12px;
    background-color: transparent;
}

QMenuBar::item:selected {
    background-color: #094771;
}

QMenuBar::item:pressed {
    background-color: #094771;
}

QMenu {
    background-color: #252526;
    color: #cccccc;
    border: 1px solid #3c3c3c;
    padding: 4px;
}

QMenu::item {
    padding: 6px 32px 6px 20px;
}

QMenu::item:selected {
    background-color: #094771;
}

QMenu::separator {
    height: 1px;
    background-color: #3c3c3c;
    margin: 4px 8px;
}

QStatusBar {
    background-color: #007acc;
    color: white;
}

QStatusBar::item {
    border: none;
}

QPushButton {
    background-color: #0e639c;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    font-weight: bold;
    min-width: 80px;
}

QPushButton:hover {
    background-color: #1177bb;
}

QPushButton:pressed {
    background-color: #0d5a8a;
}

QPushButton:disabled {
    background-color: #3c3c3c;
    color: #6c6c6c;
}

QLabel {
    color: #cccccc;
    background-color: transparent;
}

QLineEdit {
    background-color: #3c3c3c;
    color: #cccccc;
    border: 1px solid #3c3c3c;
    padding: 6px;
    border-radius: 4px;
}

QLineEdit:focus {
    border: 1px solid #007acc;
}

QTextEdit, QPlainTextEdit {
    background-color: #1e1e1e;
    color: #d4d4d4;
    border: none;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
}

QScrollBar:vertical {
    background-color: #1e1e1e;
    width: 12px;
    margin: 0;
}

QScrollBar::handle:vertical {
    background-color: #424242;
    min-height: 20px;
    border-radius: 6px;
    margin: 2px;
}

QScrollBar::handle:vertical:hover {
    background-color: #4f4f4f;
}

QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0;
}

QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
    background-color: transparent;
}

QScrollBar:horizontal {
    background-color: #1e1e1e;
    height: 12px;
    margin: 0;
}

QScrollBar::handle:horizontal {
    background-color: #424242;
    min-width: 20px;
    border-radius: 6px;
    margin: 2px;
}

QScrollBar::handle:horizontal:hover {
    background-color: #4f4f4f;
}

QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {
    width: 0;
}

QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {
    background-color: transparent;
}

QSplitter::handle {
    background-color: #3c3c3c;
}

QFrame {
    border: none;
}

QFrame[frameShape="4"] {
    background-color: #3c3c3c;
}

QFrame[frameShape="5"] {
    background-color: #3c3c3c;
}

QToolTip {
    background-color: #252526;
    color: #cccccc;
    border: 1px solid #3c3c3c;
    padding: 4px;
}

QMessageBox {
    background-color: #252526;
}

QMessageBox QLabel {
    color: #cccccc;
}

QMessageBox QPushButton {
    min-width: 80px;
}

QFileDialog {
    background-color: #252526;
}

QFileDialog QLabel {
    color: #cccccc;
}

QFileDialog QPushButton {
    min-width: 80px;
}

QTreeView, QListView {
    background-color: #1e1e1e;
    color: #cccccc;
    border: none;
}

QTreeView::item, QListView::item {
    padding: 4px;
}

QTreeView::item:selected, QListView::item:selected {
    background-color: #094771;
}

QTreeView::item:hover, QListView::item:hover {
    background-color: #2a2d2e;
}
"""

ACCENT_COLORS = {
    "blue": "#007acc",
    "green": "#4ec9b0",
    "yellow": "#dcdcaa",
    "red": "#f14c4c",
    "orange": "#ce9178",
    "purple": "#c586c0",
}
