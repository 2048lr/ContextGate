using System.Text.RegularExpressions;
using ContextGate.Core.Models;

namespace ContextGate.Core.Services;

public class IntentExtractor
{
    private static readonly Dictionary<string, string[]> IntentPatterns = new()
    {
        ["auth"] = ["auth", "login", "password", "credential", "token", "jwt", "session", "oauth", "认证", "登录", "密码", "授权"],
        ["user"] = ["user", "profile", "account", "register", "signup", "用户", "账号", "注册"],
        ["api"] = ["api", "endpoint", "route", "controller", "handler", "request", "接口", "路由", "控制器"],
        ["database"] = ["database", "db", "sql", "mongo", "redis", "model", "schema", "table", "数据库", "查询", "存储"],
        ["config"] = ["config", "setting", "option", "env", "配置", "设置", "环境变量"],
        ["utils"] = ["util", "helper", "tool", "function", "lib", "common", "工具", "辅助", "函数"],
        ["ui"] = ["component", "view", "page", "screen", "widget", "button", "input", "界面", "组件", "页面"],
        ["test"] = ["test", "spec", "mock", "vitest", "jest", "测试", "单元测试"],
        ["error"] = ["error", "exception", "handle", "catch", "错误", "异常", "处理"],
        ["security"] = ["security", "encrypt", "decrypt", "hash", "salt", "安全", "加密", "解密"]
    };

    private static readonly string[] CodeConcepts = ["function", "class", "interface", "variable", "import", "error", "test"];

    private static readonly string[] ModuleSuffixes = ["Module", "Service", "Controller", "Handler", "Manager", "Provider", "Repository", "Factory", "Builder", "Adapter"];

    public List<IntentInfo> ExtractIntents(string prompt)
    {
        var promptLower = prompt.ToLower();
        var intents = new List<IntentInfo>();

        foreach (var (name, keywords) in IntentPatterns)
        {
            var matchedKeywords = keywords.Where(k => promptLower.Contains(k.ToLower())).ToList();
            if (matchedKeywords.Count > 0)
            {
                var filePatterns = GetFilePatternsForIntent(name);
                var confidence = Math.Min((double)matchedKeywords.Count / keywords.Length * 3, 1.0);

                intents.Add(new IntentInfo
                {
                    Name = name,
                    Keywords = matchedKeywords,
                    FilePatterns = filePatterns,
                    Confidence = confidence
                });
            }
        }

        return intents.OrderByDescending(i => i.Confidence).ToList();
    }

    public List<string> ExtractFileReferences(string prompt)
    {
        var references = new List<string>();

        var quotedMatches = Regex.Matches(prompt, @"['""`]([^'""`]+\.\w+)['""`]");
        foreach (Match match in quotedMatches)
        {
            references.Add(match.Groups[1].Value);
        }

        var pathMatches = Regex.Matches(prompt, @"(?:^|\s)([\w./\\-]+\.[\w]+)(?:\s|$)", RegexOptions.Multiline);
        foreach (Match match in pathMatches)
        {
            var path = match.Groups[1].Value;
            if (path.Contains('.') && !path.StartsWith("http") && !references.Contains(path))
            {
                references.Add(path);
            }
        }

        return references.Distinct().ToList();
    }

    public List<string> ExtractModuleReferences(string prompt)
    {
        var references = new List<string>();

        var camelCaseMatches = Regex.Matches(prompt, @"\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b");
        foreach (Match match in camelCaseMatches)
        {
            references.Add(match.Groups[1].Value);
        }

        foreach (var suffix in ModuleSuffixes)
        {
            var pattern = $@"\b(\w+{suffix})\b";
            var matches = Regex.Matches(prompt, pattern);
            foreach (Match match in matches)
            {
                if (!references.Contains(match.Groups[1].Value))
                {
                    references.Add(match.Groups[1].Value);
                }
            }
        }

        return references.Distinct().ToList();
    }

    public List<string> ExtractCodeConcepts(string prompt)
    {
        var promptLower = prompt.ToLower();
        return CodeConcepts.Where(c => promptLower.Contains(c)).ToList();
    }

    public List<string> GetAllKeywords(string prompt)
    {
        var keywords = new HashSet<string>();

        foreach (var intent in ExtractIntents(prompt))
        {
            foreach (var keyword in intent.Keywords)
            {
                keywords.Add(keyword);
            }
        }

        foreach (var reference in ExtractFileReferences(prompt))
        {
            keywords.Add(reference);
            var fileName = Path.GetFileNameWithoutExtension(reference);
            if (!string.IsNullOrEmpty(fileName))
            {
                keywords.Add(fileName);
            }
        }

        foreach (var module in ExtractModuleReferences(prompt))
        {
            keywords.Add(module);
        }

        foreach (var concept in ExtractCodeConcepts(prompt))
        {
            keywords.Add(concept);
        }

        var wordMatches = Regex.Matches(prompt, @"\b[a-zA-Z]{3,}\b");
        foreach (Match match in wordMatches)
        {
            var word = match.Value.ToLower();
            if (word.Length >= 3 && !IsStopWord(word))
            {
                keywords.Add(word);
            }
        }

        return keywords.ToList();
    }

    private static List<string> GetFilePatternsForIntent(string intentName)
    {
        return intentName switch
        {
            "auth" => ["*auth*", "*login*", "*session*", "*token*", "*credential*"],
            "user" => ["*user*", "*account*", "*profile*", "*register*"],
            "api" => ["*api*", "*route*", "*controller*", "*handler*", "*endpoint*"],
            "database" => ["*db*", "*model*", "*schema*", "*migration*", "*repository*"],
            "config" => ["*config*", "*setting*", "*env*", "*.env", "*.config.*"],
            "utils" => ["*util*", "*helper*", "*tool*", "*common*", "*lib*"],
            "ui" => ["*component*", "*view*", "*page*", "*screen*", "*widget*"],
            "test" => ["*test*", "*spec*", "*mock*", "*__test__*"],
            "error" => ["*error*", "*exception*", "*handler*", "*middleware*"],
            "security" => ["*security*", "*crypto*", "*encrypt*", "*auth*"],
            _ => []
        };
    }

    private static bool IsStopWord(string word)
    {
        var stopWords = new HashSet<string>
        {
            "the", "and", "for", "are", "but", "not", "you", "all", "can",
            "had", "her", "was", "one", "our", "out", "has", "have", "this",
            "that", "with", "from", "they", "been", "said", "each", "which",
            "their", "will", "other", "about", "many", "then", "them",
            "some", "would", "make", "like", "into", "time", "very",
            "when", "come", "could", "than", "look", "only", "more",
            "what", "how", "just", "over", "such", "take", "also"
        };
        return stopWords.Contains(word);
    }
}
