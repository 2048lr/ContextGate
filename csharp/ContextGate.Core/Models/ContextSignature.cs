namespace ContextGate.Core.Models;

/// <summary>
/// 上下文文件签名信息
/// </summary>
public class ContextSignature
{
    /// <summary>
    /// 上下文文件主哈希
    /// </summary>
    public string MainHash { get; set; } = string.Empty;

    /// <summary>
    /// 组合哈希（包含所有引用文件）
    /// </summary>
    public string CombinedHash { get; set; } = string.Empty;

    /// <summary>
    /// 文件哈希字典
    /// </summary>
    public Dictionary<string, string> FileHashes { get; set; } = new();

    /// <summary>
    /// 文件数量
    /// </summary>
    public int FileCount { get; set; }

    /// <summary>
    /// 文件列表
    /// </summary>
    public List<string> Files { get; set; } = new();

    /// <summary>
    /// 上下文文件路径
    /// </summary>
    public string File { get; set; } = string.Empty;
}
