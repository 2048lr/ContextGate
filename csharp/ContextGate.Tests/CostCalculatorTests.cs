using ContextGate.Core.Services;

namespace ContextGate.Tests;

public class CostCalculatorTests
{
    private readonly CostCalculator _calculator = new();

    [Fact]
    public void CalculateCost_KnownModel()
    {
        var cost = _calculator.CalculateCost("gpt-4", 1000, 1000);
        Assert.True(cost > 0);
        Assert.Equal(0.09m, cost);
    }

    [Fact]
    public void CalculateCost_UnknownModel_UsesDefault()
    {
        var cost = _calculator.CalculateCost("unknown-model", 1000, 1000);
        Assert.True(cost > 0);
    }

    [Fact]
    public void CalculateCost_ZeroTokens()
    {
        var cost = _calculator.CalculateCost("gpt-4", 0, 0);
        Assert.Equal(0m, cost);
    }
}
