namespace ContextGate.Core.Models;

/// <summary>
/// 扫描器配置
/// </summary>
public class ScannerConfig
{
    /// <summary>
    /// 最大文件大小（字节）
    /// </summary>
    public long MaxFileSize { get; set; } = 1048576; // 1MB

    /// <summary>
    /// 包含的文件扩展名
    /// </summary>
    public List<string> IncludeExtensions { get; set; } = new()
    {
        ".py", ".js", ".ts", ".jsx", ".tsx", ".cs", ".java", ".go", ".rs",
        ".cpp", ".c", ".h", ".hpp", ".php", ".rb", ".swift", ".kt"
    };

    /// <summary>
    /// 排除的目录
    /// </summary>
    public List<string> ExcludeDirectories { get; set; } = new()
    {
        "node_modules", ".git", "dist", "build", "bin", "obj", "__pycache__"
    };
}
