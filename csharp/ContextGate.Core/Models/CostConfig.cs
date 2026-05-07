namespace ContextGate.Core.Models;

public class CostConfig
{
    public Dictionary<string, ModelPricing> ModelPricing { get; set; } = new();

    public static CostConfig Default => new()
    {
        ModelPricing = new Dictionary<string, ModelPricing>
        {
            ["gpt-4"] = new() { InputPer1K = 0.03m, OutputPer1K = 0.06m },
            ["gpt-4-turbo"] = new() { InputPer1K = 0.01m, OutputPer1K = 0.03m },
            ["gpt-4o"] = new() { InputPer1K = 0.005m, OutputPer1K = 0.015m },
            ["gpt-4o-mini"] = new() { InputPer1K = 0.00015m, OutputPer1K = 0.0006m },
            ["gpt-3.5-turbo"] = new() { InputPer1K = 0.0005m, OutputPer1K = 0.0015m },
            ["glm-4"] = new() { InputPer1K = 0.1m, OutputPer1K = 0.1m },
            ["glm-4-flash"] = new() { InputPer1K = 0.0001m, OutputPer1K = 0.0001m },
            ["deepseek-chat"] = new() { InputPer1K = 0.001m, OutputPer1K = 0.002m },
            ["deepseek-coder"] = new() { InputPer1K = 0.001m, OutputPer1K = 0.002m }
        }
    };
}

public class ModelPricing
{
    public decimal InputPer1K { get; set; }
    public decimal OutputPer1K { get; set; }
}
