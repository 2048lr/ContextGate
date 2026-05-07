using Newtonsoft.Json;

namespace ContextGate.Core.Models;

/// <summary>
/// OpenAI 兼容的聊天请求
/// </summary>
public class ChatRequest
{
    [JsonProperty("model")]
    public string Model { get; set; } = string.Empty;

    [JsonProperty("messages")]
    public List<ChatMessage> Messages { get; set; } = new();

    [JsonProperty("temperature")]
    public double? Temperature { get; set; }

    [JsonProperty("max_tokens")]
    public int? MaxTokens { get; set; }

    [JsonProperty("stream")]
    public bool Stream { get; set; }

    [JsonProperty("top_p")]
    public double? TopP { get; set; }

    [JsonProperty("frequency_penalty")]
    public double? FrequencyPenalty { get; set; }

    [JsonProperty("presence_penalty")]
    public double? PresencePenalty { get; set; }
}

/// <summary>
/// 聊天消息
/// </summary>
public class ChatMessage
{
    [JsonProperty("role")]
    public string Role { get; set; } = string.Empty;

    [JsonProperty("content")]
    public string Content { get; set; } = string.Empty;
}
