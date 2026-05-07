using Newtonsoft.Json;

namespace ContextGate.Core.Models;

/// <summary>
/// OpenAI 兼容的聊天响应
/// </summary>
public class ChatResponse
{
    [JsonProperty("id")]
    public string Id { get; set; } = string.Empty;

    [JsonProperty("object")]
    public string Object { get; set; } = "chat.completion";

    [JsonProperty("created")]
    public long Created { get; set; }

    [JsonProperty("model")]
    public string Model { get; set; } = string.Empty;

    [JsonProperty("choices")]
    public List<ChatChoice> Choices { get; set; } = new();

    [JsonProperty("usage")]
    public ChatUsage? Usage { get; set; }
}

/// <summary>
/// 聊天选择项
/// </summary>
public class ChatChoice
{
    [JsonProperty("index")]
    public int Index { get; set; }

    [JsonProperty("message")]
    public ChatMessage? Message { get; set; }

    [JsonProperty("delta")]
    public ChatMessage? Delta { get; set; }

    [JsonProperty("finish_reason")]
    public string? FinishReason { get; set; }
}

/// <summary>
/// Token 使用情况
/// </summary>
public class ChatUsage
{
    [JsonProperty("prompt_tokens")]
    public int PromptTokens { get; set; }

    [JsonProperty("completion_tokens")]
    public int CompletionTokens { get; set; }

    [JsonProperty("total_tokens")]
    public int TotalTokens { get; set; }
}
