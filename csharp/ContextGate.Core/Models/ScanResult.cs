namespace ContextGate.Core.Models;

/// <summary>
/// 代码扫描结果
/// </summary>
public class ScanResult
{
    /// <summary>
    /// 扫描的文件数
    /// </summary>
    public int FileCount { get; set; }

    /// <summary>
    /// 总字符数
    /// </summary>
    public long TotalChars { get; set; }

    /// <summary>
    /// 估计的 Token 数
    /// </summary>
    public long EstimatedTokens { get; set; }

    /// <summary>
    /// 输出文件路径
    /// </summary>
    public string OutputPath { get; set; } = string.Empty;

    /// <summary>
    /// 扫描耗时（毫秒）
    /// </summary>
    public long ElapsedMilliseconds { get; set; }
}

/// <summary>
/// 代码文件信息
/// </summary>
public class CodeFile
{
    /// <summary>
    /// 文件路径
    /// </summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>
    /// 相对路径
    /// </summary>
    public string RelativePath { get; set; } = string.Empty;

    /// <summary>
    /// 文件内容
    /// </summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>
    /// 文件大小（字节）
    /// </summary>
    public long Size { get; set; }

    /// <summary>
    /// 相关性分数（0-100）
    /// </summary>
    public int RelevanceScore { get; set; }
}
