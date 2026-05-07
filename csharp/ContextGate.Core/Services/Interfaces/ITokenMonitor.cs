using ContextGate.Core.Models;

namespace ContextGate.Core.Services.Interfaces;

public interface ITokenMonitor
{
    void RecordRequest(RequestLog log);

    StatisticsSummary GetSummary();

    Statistics GetTodayStats();

    Statistics GetMonthStats();

    Statistics GetTotalStats();

    Task<List<DailyStats>> GetDailyStats(int days = 7);

    Task ResetAsync();

    Task FlushAsync();

    void ClearAll();

    void Close();
}
