// Patch monitor.js to add savings percentage calculation
const fs = require('fs');
const filePath = 'app/gui-js/lib/monitor.js';
let content = fs.readFileSync(filePath, 'utf8');

// 1. In the return object of getSummary(), add savingsPercent and monthSavingsPercent
const returnSearch = `      return {
        total: {
          requestCount,
          totalTokens,
          totalCost,
          cacheHits,
          memoryCacheSize: this.lruCache.size
        },
        today: todayData,
        month: monthData,`;

const returnReplace = `      // 计算节省百分比：缓存命中的token占全部token的比例
      let savingsPercent = 0
      let todayCachedTokens = 0
      try {
        const cachedResult = this.db.exec(
          "SELECT COALESCE(SUM(total_tokens), 0) FROM requests WHERE cached = 1 AND date(timestamp) = date('now')"
        )
        todayCachedTokens = (cachedResult.length > 0 && cachedResult[0].values[0][0]) || 0
        const todayAllTokens = todayData.tokens + todayCachedTokens
        if (todayAllTokens > 0) {
          savingsPercent = Math.round((todayCachedTokens / todayAllTokens) * 100)
        }
      } catch (e) {}

      // 计算本月节省百分比
      let monthSavingsPercent = 0
      try {
        const monthCachedResult = this.db.exec(
          "SELECT COALESCE(SUM(total_tokens), 0) FROM requests WHERE cached = 1 AND strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')"
        )
        const monthCachedTokens = (monthCachedResult.length > 0 && monthCachedResult[0].values[0][0]) || 0
        const monthAllTokens = monthData.tokens + monthCachedTokens
        if (monthAllTokens > 0) {
          monthSavingsPercent = Math.round((monthCachedTokens / monthAllTokens) * 100)
        }
      } catch (e) {}

      return {
        total: {
          requestCount,
          totalTokens,
          totalCost,
          cacheHits,
          memoryCacheSize: this.lruCache.size
        },
        today: todayData,
        month: monthData,`;

if (content.includes(returnSearch)) {
  content = content.replace(returnSearch, returnReplace);
  console.log('Patched return block');
} else {
  console.log('ERROR: Could not find return block to patch');
  process.exit(1);
}

// 2. Also add savingsPercent and monthSavingsPercent to the return object
const uptimeSearch = `        uptime: process.uptime()
      }
    } catch (e) {
      return {
        total: {
          requestCount: 0,
          totalTokens: 0,
          totalCost: 0,
          cacheHits: 0,
          memoryCacheSize: this.lruCache.size
        },
        today: { requests: 0, tokens: 0, cost: 0, cacheHits: 0 },
        month: { requests: 0, tokens: 0, cost: 0 },
        byProvider: [],
        uptime: process.uptime()
      }`;

const uptimeReplace = `        savingsPercent,
        monthSavingsPercent,
        uptime: process.uptime()
      }
    } catch (e) {
      return {
        total: {
          requestCount: 0,
          totalTokens: 0,
          totalCost: 0,
          cacheHits: 0,
          memoryCacheSize: this.lruCache.size
        },
        today: { requests: 0, tokens: 0, cost: 0, cacheHits: 0 },
        month: { requests: 0, tokens: 0, cost: 0 },
        byProvider: [],
        savingsPercent: 0,
        monthSavingsPercent: 0,
        uptime: process.uptime()
      }`;

if (content.includes(uptimeSearch)) {
  content = content.replace(uptimeSearch, uptimeReplace);
  console.log('Patched uptime block');
} else {
  console.log('ERROR: Could not find uptime block to patch');
  process.exit(1);
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('monitor.js patched successfully');
