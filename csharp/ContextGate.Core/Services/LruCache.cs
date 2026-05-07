using System.Collections.Concurrent;

namespace ContextGate.Core.Services;

/// <summary>
/// LRU 缓存实现
/// </summary>
/// <typeparam name="TKey">键类型</typeparam>
/// <typeparam name="TValue">值类型</typeparam>
public class LruCache<TKey, TValue> where TKey : notnull
{
    private readonly int _capacity;
    private readonly ConcurrentDictionary<TKey, LinkedListNode<CacheItem>> _cache;
    private readonly LinkedList<CacheItem> _lruList;
    private readonly object _lock = new();

    public LruCache(int capacity)
    {
        if (capacity <= 0)
            throw new ArgumentException("Capacity must be greater than 0", nameof(capacity));

        _capacity = capacity;
        _cache = new ConcurrentDictionary<TKey, LinkedListNode<CacheItem>>();
        _lruList = new LinkedList<CacheItem>();
    }

    public int Count => _cache.Count;

    public bool TryGet(TKey key, out TValue? value)
    {
        if (_cache.TryGetValue(key, out var node))
        {
            lock (_lock)
            {
                // 移动到链表头部（最近使用）
                _lruList.Remove(node);
                _lruList.AddFirst(node);
            }

            value = node.Value.Value;
            return true;
        }

        value = default;
        return false;
    }

    public void Set(TKey key, TValue value)
    {
        lock (_lock)
        {
            if (_cache.TryGetValue(key, out var existingNode))
            {
                // 更新现有项
                _lruList.Remove(existingNode);
                existingNode.Value.Value = value;
                _lruList.AddFirst(existingNode);
            }
            else
            {
                // 添加新项
                if (_cache.Count >= _capacity)
                {
                    // 移除最久未使用的项
                    var lruNode = _lruList.Last;
                    if (lruNode != null)
                    {
                        _lruList.RemoveLast();
                        _cache.TryRemove(lruNode.Value.Key, out _);
                    }
                }

                var newItem = new CacheItem { Key = key, Value = value };
                var newNode = new LinkedListNode<CacheItem>(newItem);
                _lruList.AddFirst(newNode);
                _cache[key] = newNode;
            }
        }
    }

    public void Clear()
    {
        lock (_lock)
        {
            _cache.Clear();
            _lruList.Clear();
        }
    }

    public bool Remove(TKey key)
    {
        lock (_lock)
        {
            if (_cache.TryRemove(key, out var node))
            {
                _lruList.Remove(node);
                return true;
            }
            return false;
        }
    }

    private class CacheItem
    {
        public TKey Key { get; set; } = default!;
        public TValue Value { get; set; } = default!;
    }
}
