# 参考：cc-switch 的 OpenCode Go 用量查询脚本（原文）

> 来源：用户之前在 cc-switch 中使用的查询脚本。
> M1 的解析语义（percent 钳制、remaining = 100 - used、extra 文案、倒计时格式）与此脚本一致。

```js
({
  request: {
    url: "{{baseUrl}}/v1/usage",
    method: "GET",
    headers: {
      Authorization: "Bearer {{apiKey}}",
      Accept: "application/json",
      "User-Agent": "cc-switch/1.0",
    },
  },

  extractor: function (response) {
    var data = response;

    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (error) {
        return {
          isValid: false,
          invalidMessage: "OpenCode Go 返回的数据不是有效 JSON",
        };
      }
    }

    var usage = data && data.usage;

    if (!usage) {
      return {
        isValid: false,
        invalidMessage: "没有找到 OpenCode Go 用量数据",
      };
    }

    function getUsedPercent(name) {
      var item = usage[name];

      if (!item || item.percent === undefined || item.percent === null) {
        return null;
      }

      var value = Number(item.percent);

      if (isNaN(value)) {
        return null;
      }

      return Math.max(0, Math.min(100, value));
    }

    function formatRemainingPercent(usedPercent) {
      if (usedPercent === null) {
        return "--";
      }

      return Math.round(100 - usedPercent) + "%";
    }

    function formatCountdown(isoTime) {
      if (!isoTime) {
        return "--";
      }

      var resetTimestamp = Date.parse(isoTime);

      if (isNaN(resetTimestamp)) {
        return "--";
      }

      var seconds = Math.max(
        0,
        Math.floor((resetTimestamp - Date.now()) / 1000),
      );

      if (seconds <= 0) {
        return "已到期";
      }

      var days = Math.floor(seconds / 86400);
      seconds = seconds % 86400;

      var hours = Math.floor(seconds / 3600);
      seconds = seconds % 3600;

      var minutes = Math.floor(seconds / 60);

      if (days > 0) {
        return days + "d" + hours + "h";
      }

      if (hours > 0) {
        return hours + "h" + minutes + "m";
      }

      if (minutes > 0) {
        return minutes + "m";
      }

      return Math.floor(seconds) + "s";
    }

    var rolling = usage.rolling || {};
    var weekly = usage.weekly || {};
    var monthly = usage.monthly || {};

    var rollingUsed = getUsedPercent("rolling");
    var weeklyUsed = getUsedPercent("weekly");
    var monthlyUsed = getUsedPercent("monthly");

    var monthlyRemaining = monthlyUsed === null ? 0 : 100 - monthlyUsed;

    return {
      isValid: true,
      planName: "OpenCode Go",

      // 保留这个字段，CC Switch 才会显示绿色高亮数字
      remaining: monthlyRemaining,
      unit: "%",

      // 不返回 used 和 total，避免出现"已使用"标签
      extra:
        "5小时: " +
        formatRemainingPercent(rollingUsed) +
        "  7天: " +
        formatRemainingPercent(weeklyUsed) +
        "  ◷ " +
        formatCountdown(monthly.resetsAt) +
        "  5小时重置 " +
        formatCountdown(rolling.resetsAt) +
        " · 7天重置 " +
        formatCountdown(weekly.resetsAt),
    };
  },
});
```

## 与本插件实现的对应关系

| cc-switch 脚本 | dsh-provider-usage M1 |
|---|---|
| `request` | `lib/index.js` 的 `doQuery()`（fetch `<baseUrl>/v1/usage`，Bearer + UA 头） |
| `extractor` 的 getUsedPercent / 钳制 | `getUsedPercent()` |
| `formatRemainingPercent` / `formatCountdown` | 同名函数 |
| `remaining` / `unit` / `extra` | 响应 JSON 同名字段 |
| `{{apiKey}}` | 由 `resolveApiKey()` 从 DSH 凭证层解析 |
