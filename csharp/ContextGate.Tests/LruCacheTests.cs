using ContextGate.Core.Services;

namespace ContextGate.Tests;

public class LruCacheTests
{
    [Fact]
    public void SetAndGet_BasicOperation()
    {
        var cache = new LruCache<string, int>(10);
        cache.Set("key1", 1);
        Assert.True(cache.TryGet("key1", out var value));
        Assert.Equal(1, value);
    }

    [Fact]
    public void TryGet_ReturnsFalseForMissingKey()
    {
        var cache = new LruCache<string, int>(10);
        Assert.False(cache.TryGet("missing", out _));
    }

    [Fact]
    public void Set_UpdatesExistingKey()
    {
        var cache = new LruCache<string, int>(10);
        cache.Set("key1", 1);
        cache.Set("key1", 2);
        cache.TryGet("key1", out var value);
        Assert.Equal(2, value);
    }

    [Fact]
    public void Set_EvictsOldestWhenFull()
    {
        var cache = new LruCache<string, int>(3);
        cache.Set("a", 1);
        cache.Set("b", 2);
        cache.Set("c", 3);
        cache.Set("d", 4);

        Assert.False(cache.TryGet("a", out _));
        Assert.True(cache.TryGet("d", out var value));
        Assert.Equal(4, value);
        Assert.Equal(3, cache.Count);
    }

    [Fact]
    public void Clear_RemovesAllItems()
    {
        var cache = new LruCache<string, int>(10);
        cache.Set("a", 1);
        cache.Set("b", 2);
        cache.Clear();
        Assert.Equal(0, cache.Count);
    }

    [Fact]
    public void Remove_DeletesSpecificKey()
    {
        var cache = new LruCache<string, int>(10);
        cache.Set("a", 1);
        cache.Set("b", 2);
        Assert.True(cache.Remove("a"));
        Assert.False(cache.TryGet("a", out _));
        Assert.Equal(1, cache.Count);
    }

    [Fact]
    public void TryGet_MovesToHead()
    {
        var cache = new LruCache<string, int>(3);
        cache.Set("a", 1);
        cache.Set("b", 2);
        cache.Set("c", 3);

        cache.TryGet("a", out _);

        cache.Set("d", 4);

        Assert.True(cache.TryGet("a", out _));
        Assert.False(cache.TryGet("b", out _));
    }
}
