using ContextGate.Core.Models;

namespace ContextGate.Core.Services;

public class CostCalculator
{
    private readonly CostConfig _config;

    public CostCalculator(CostConfig? config = null)
    {
        _config = config ?? CostConfig.Default;
    }

    public decimal CalculateCost(string model, int promptTokens, int completionTokens)
    {
        if (!_config.ModelPricing.TryGetValue(model, out var pricing))
        {
            pricing = new ModelPricing { InputPer1K = 0.001m, OutputPer1K = 0.002m };
        }
        var inputCost = (decimal)promptTokens / 1000 * pricing.InputPer1K;
        var outputCost = (decimal)completionTokens / 1000 * pricing.OutputPer1K;
        return inputCost + outputCost;
    }
}
