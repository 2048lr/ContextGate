using ContextGate.Core.Models;
using ContextGate.Core.Services.Interfaces;
using Microsoft.Data.Sqlite;
using System.Diagnostics;
using System.Threading.Channels;

namespace ContextGate.Core.Services;

public class TokenMonitor : ITokenMonitor, IAsyncDisposable, IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly Stopwatch _uptime;
    private readonly Channel<RequestLog> _writeChannel;
    private readonly Timer _flushTimer;
    private readonly object _flushLock = new();
    private bool _disposed;

    public TokenMonitor(string dbPath)
    {
        var connectionString = $"Data Source={dbPath}";
        _connection = new SqliteConnection(connectionString);
        _connection.Open();

        InitializeDatabase();
        _uptime = Stopwatch.StartNew();

        _writeChannel = Channel.CreateUnbounded<RequestLog>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        _flushTimer = new Timer(_ => FlushToDisk(), null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
    }

    private void InitializeDatabase()
    {
        var createTableSql = @"
            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                total_tokens INTEGER NOT NULL,
                prompt_tokens INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                cost REAL NOT NULL,
                cached INTEGER NOT NULL,
                path TEXT,
                method TEXT,
                response_time INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS daily_stats (
                date TEXT PRIMARY KEY,
                total_requests INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0,
                cache_hits INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS monthly_stats (
                month TEXT PRIMARY KEY,
                total_requests INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp);
            CREATE INDEX IF NOT EXISTS idx_provider ON requests(provider);
            CREATE INDEX IF NOT EXISTS idx_cached ON requests(cached);
        ";

        using var command = new SqliteCommand(createTableSql, _connection);
        command.ExecuteNonQuery();
    }

    public void RecordRequest(RequestLog log)
    {
        _writeChannel.Writer.TryWrite(log);
    }

    private void WriteRequestInternal(RequestLog log)
    {
        var sql = @"
            INSERT INTO requests (timestamp, provider, model, total_tokens, prompt_tokens, 
                                 completion_tokens, cost, cached, path, method, response_time)
            VALUES (@timestamp, @provider, @model, @totalTokens, @promptTokens, 
                   @completionTokens, @cost, @cached, @path, @method, @responseTime)
        ";

        using var command = new SqliteCommand(sql, _connection);
        command.Parameters.AddWithValue("@timestamp", log.Timestamp.ToString("yyyy-MM-dd HH:mm:ss"));
        command.Parameters.AddWithValue("@provider", log.Provider);
        command.Parameters.AddWithValue("@model", log.Model);
        command.Parameters.AddWithValue("@totalTokens", log.TotalTokens);
        command.Parameters.AddWithValue("@promptTokens", log.PromptTokens);
        command.Parameters.AddWithValue("@completionTokens", log.CompletionTokens);
        command.Parameters.AddWithValue("@cost", (double)log.Cost);
        command.Parameters.AddWithValue("@cached", log.Cached ? 1 : 0);
        command.Parameters.AddWithValue("@path", (object?)log.Path ?? DBNull.Value);
        command.Parameters.AddWithValue("@method", log.Method);
        command.Parameters.AddWithValue("@responseTime", log.ResponseTime);

        command.ExecuteNonQuery();

        UpdateDailyStats(log);
        UpdateMonthlyStats(log);
    }

    private void UpdateDailyStats(RequestLog log)
    {
        var date = log.Timestamp.ToString("yyyy-MM-dd");
        var sql = @"
            INSERT INTO daily_stats (date, total_requests, total_tokens, total_cost, cache_hits)
            VALUES (@date, 1, @totalTokens, @cost, @cacheHits)
            ON CONFLICT(date) DO UPDATE SET
                total_requests = total_requests + 1,
                total_tokens = total_tokens + @totalTokens,
                total_cost = total_cost + @cost,
                cache_hits = cache_hits + @cacheHits
        ";

        using var command = new SqliteCommand(sql, _connection);
        command.Parameters.AddWithValue("@date", date);
        command.Parameters.AddWithValue("@totalTokens", log.TotalTokens);
        command.Parameters.AddWithValue("@cost", (double)log.Cost);
        command.Parameters.AddWithValue("@cacheHits", log.Cached ? 1 : 0);

        command.ExecuteNonQuery();
    }

    private void UpdateMonthlyStats(RequestLog log)
    {
        var month = log.Timestamp.ToString("yyyy-MM");
        var sql = @"
            INSERT INTO monthly_stats (month, total_requests, total_tokens, total_cost)
            VALUES (@month, 1, @totalTokens, @cost)
            ON CONFLICT(month) DO UPDATE SET
                total_requests = total_requests + 1,
                total_tokens = total_tokens + @totalTokens,
                total_cost = total_cost + @cost
        ";

        using var command = new SqliteCommand(sql, _connection);
        command.Parameters.AddWithValue("@month", month);
        command.Parameters.AddWithValue("@totalTokens", log.TotalTokens);
        command.Parameters.AddWithValue("@cost", (double)log.Cost);

        command.ExecuteNonQuery();
    }

    public void FlushToDisk()
    {
        lock (_flushLock)
        {
            var logs = new List<RequestLog>();
            while (_writeChannel.Reader.TryRead(out var log))
            {
                logs.Add(log);
            }

            foreach (var log in logs)
            {
                try
                {
                    WriteRequestInternal(log);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Error writing request log: {ex.Message}");
                }
            }
        }
    }

    public Task FlushAsync()
    {
        FlushToDisk();
        return Task.CompletedTask;
    }

    public StatisticsSummary GetSummary()
    {
        try
        {
            var today = GetTodayStats();
            var month = GetMonthStats();
            var total = GetTotalStats();

            var todayCachedTokens = GetCachedTokens("date(timestamp) = date('now')");
            var todayAllTokens = today.Tokens + todayCachedTokens;
            var savingsPercent = todayAllTokens > 0
                ? (int)Math.Round((double)todayCachedTokens / todayAllTokens * 100)
                : 0;

            var monthCachedTokens = GetCachedTokens("strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')");
            var monthAllTokens = month.Tokens + monthCachedTokens;
            var monthSavingsPercent = monthAllTokens > 0
                ? (int)Math.Round((double)monthCachedTokens / monthAllTokens * 100)
                : 0;

            return new StatisticsSummary
            {
                Today = today,
                Month = month,
                Total = total,
                SavingsPercent = savingsPercent,
                MonthSavingsPercent = monthSavingsPercent,
                Uptime = _uptime.Elapsed.TotalSeconds
            };
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error getting summary: {ex.Message}");
            return new StatisticsSummary
            {
                Today = new Statistics(),
                Month = new Statistics(),
                Total = new Statistics(),
                Uptime = _uptime.Elapsed.TotalSeconds
            };
        }
    }

    public Statistics GetTodayStats()
    {
        return GetStats("date(timestamp) = date('now')");
    }

    public Statistics GetMonthStats()
    {
        return GetStats("strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')");
    }

    public Statistics GetTotalStats()
    {
        return GetStats("1=1");
    }

    private Statistics GetStats(string whereClause)
    {
        var sql = $@"
            SELECT 
                COUNT(*) as requests,
                COALESCE(SUM(total_tokens), 0) as tokens,
                COALESCE(SUM(cost), 0) as cost,
                COALESCE(SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END), 0) as cache_hits
            FROM requests
            WHERE {whereClause}
        ";

        using var command = new SqliteCommand(sql, _connection);
        using var reader = command.ExecuteReader();

        if (reader.Read())
        {
            var stats = new Statistics
            {
                Requests = reader.GetInt32(0),
                Tokens = reader.GetInt64(1),
                Cost = (decimal)reader.GetDouble(2),
                CacheHits = reader.GetInt32(3),
                Uptime = _uptime.Elapsed.TotalSeconds
            };

            stats.ByProvider = GetProviderStats(whereClause);

            return stats;
        }

        return new Statistics { Uptime = _uptime.Elapsed.TotalSeconds };
    }

    private List<ProviderStats> GetProviderStats(string whereClause)
    {
        var sql = $@"
            SELECT provider, COUNT(*) as count, 
                   COALESCE(SUM(total_tokens), 0) as tokens,
                   COALESCE(SUM(cost), 0) as cost
            FROM requests
            WHERE {whereClause}
            GROUP BY provider
        ";

        var result = new List<ProviderStats>();
        using var command = new SqliteCommand(sql, _connection);
        using var reader = command.ExecuteReader();

        while (reader.Read())
        {
            result.Add(new ProviderStats
            {
                Provider = reader.GetString(0),
                Count = reader.GetInt32(1),
                Tokens = reader.GetInt64(2),
                Cost = (decimal)reader.GetDouble(3)
            });
        }

        return result;
    }

    private long GetCachedTokens(string whereClause)
    {
        var sql = $@"
            SELECT COALESCE(SUM(total_tokens), 0)
            FROM requests
            WHERE cached = 1 AND {whereClause}
        ";

        using var command = new SqliteCommand(sql, _connection);
        var result = command.ExecuteScalar();
        return result != null ? Convert.ToInt64(result) : 0;
    }

    public Task<List<DailyStats>> GetDailyStats(int days = 7)
    {
        var result = new List<DailyStats>();

        try
        {
            var sql = @"
                SELECT date, total_requests, total_tokens, total_cost, cache_hits
                FROM daily_stats
                ORDER BY date DESC
                LIMIT @days
            ";

            using var command = new SqliteCommand(sql, _connection);
            command.Parameters.AddWithValue("@days", days);
            using var reader = command.ExecuteReader();

            while (reader.Read())
            {
                result.Add(new DailyStats
                {
                    Date = reader.GetString(0),
                    TotalRequests = reader.GetInt32(1),
                    TotalTokens = reader.GetInt64(2),
                    TotalCost = (decimal)reader.GetDouble(3),
                    CacheHits = reader.GetInt32(4)
                });
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error getting daily stats: {ex.Message}");
        }

        return Task.FromResult(result);
    }

    public Task ResetAsync()
    {
        ClearAll();
        return Task.CompletedTask;
    }

    public void ClearAll()
    {
        FlushToDisk();

        using var command1 = new SqliteCommand("DELETE FROM requests", _connection);
        command1.ExecuteNonQuery();

        using var command2 = new SqliteCommand("DELETE FROM daily_stats", _connection);
        command2.ExecuteNonQuery();

        using var command3 = new SqliteCommand("DELETE FROM monthly_stats", _connection);
        command3.ExecuteNonQuery();
    }

    public void Close()
    {
        FlushToDisk();
        _flushTimer?.Dispose();
        _connection?.Close();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Close();
        _connection?.Dispose();
    }

    public ValueTask DisposeAsync()
    {
        if (_disposed) return ValueTask.CompletedTask;
        _disposed = true;
        FlushToDisk();
        _flushTimer?.Dispose();
        _connection?.Close();
        _connection?.Dispose();
        return ValueTask.CompletedTask;
    }
}
