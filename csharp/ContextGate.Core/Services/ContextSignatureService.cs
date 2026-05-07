using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ContextGate.Core.Models;
using ContextGate.Core.Services.Interfaces;

namespace ContextGate.Core.Services;

/// <summary>
/// 上下文签名服务实现
/// </summary>
public class ContextSignatureService : IContextSignatureService
{
    private readonly string _contextFile;
    private readonly string? _projectRoot;
    private ContextSignature? _currentSignature;

    public ContextSignatureService(string contextFile, string? projectRoot = null)
    {
        _contextFile = contextFile;
        _projectRoot = projectRoot;
        ReloadSignature();
    }

    public ContextSignature? ComputeSignature(string contextFile, string? projectRoot)
    {
        try
        {
            if (!File.Exists(contextFile))
                return null;

            var content = File.ReadAllText(contextFile);
            var mainHash = ComputeSha1(content);

            // 提取文件列表
            var files = new List<string>();
            var fileHashDict = new Dictionary<string, string>();
            var regex = new Regex(@"^# File: (.+)$", RegexOptions.Multiline);
            var matches = regex.Matches(content);

            foreach (Match match in matches)
            {
                var filePath = match.Groups[1].Value;
                files.Add(filePath);

                if (!string.IsNullOrEmpty(projectRoot))
                {
                    var absPath = Path.Combine(projectRoot, filePath);
                    var hash = ComputeFileHash(absPath);
                    if (!string.IsNullOrEmpty(hash))
                    {
                        fileHashDict[filePath] = hash;
                    }
                }
            }

            // 计算组合哈希
            var combinedHash = ComputeSha1(JsonSerializer.Serialize(fileHashDict));

            return new ContextSignature
            {
                MainHash = mainHash,
                CombinedHash = combinedHash,
                FileHashes = fileHashDict,
                FileCount = files.Count,
                Files = files,
                File = contextFile
            };
        }
        catch
        {
            return null;
        }
    }

    public string GetContextHash()
    {
        if (_currentSignature == null)
            return "none";

        return !string.IsNullOrEmpty(_currentSignature.CombinedHash)
            ? _currentSignature.CombinedHash
            : _currentSignature.MainHash;
    }

    public bool CheckContextChanged()
    {
        var newSignature = ComputeSignature(_contextFile, _projectRoot);
        if (newSignature == null)
            return false;

        if (_currentSignature == null)
            return true;

        return newSignature.CombinedHash != _currentSignature.CombinedHash ||
               newSignature.MainHash != _currentSignature.MainHash;
    }

    public void ReloadSignature()
    {
        if (File.Exists(_contextFile))
        {
            _currentSignature = ComputeSignature(_contextFile, _projectRoot);
        }
    }

    private static string? ComputeFileHash(string filePath)
    {
        try
        {
            if (!File.Exists(filePath))
                return null;

            using var stream = File.OpenRead(filePath);
            using var sha1 = SHA1.Create();
            var hash = sha1.ComputeHash(stream);
            return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        }
        catch
        {
            return null;
        }
    }

    private static string ComputeSha1(string input)
    {
        using var sha1 = SHA1.Create();
        var hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(input));
        return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
    }
}
