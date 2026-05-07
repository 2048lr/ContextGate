namespace ContextGate.Core.Services.Interfaces;

/// <summary>
/// 上下文签名服务接口
/// </summary>
public interface IContextSignatureService
{
    /// <summary>
    /// 计算上下文文件签名
    /// </summary>
    Models.ContextSignature? ComputeSignature(string contextFile, string? projectRoot);

    /// <summary>
    /// 获取当前上下文哈希
    /// </summary>
    string GetContextHash();

    /// <summary>
    /// 检查上下文是否已变更
    /// </summary>
    bool CheckContextChanged();

    /// <summary>
    /// 重新加载上下文签名
    /// </summary>
    void ReloadSignature();
}
