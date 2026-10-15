# 发布操作手册

**先读 `README.md` 的「账号安全规则」，并按 `browser.md` 完成登录检查和账号核对。** 发布是对外可见、难以撤回的操作，宁可停下来问用户，也不要冒险。

## 数据位置

当前账号数据目录下：

- `schedule.json`：发布排期
- `notes/<笔记id>/`：`meta.json`（标题、话题）、`content.md`（正文）、`cover.png`（封面）、`images/`（其他配图）

### schedule.json 条目

```json
{
  "id": "s_xxx",
  "noteId": "n_xxx",
  "title": "笔记标题",
  "publishAt": "2026-10-20T12:00:00.000Z",
  "mode": "auto | remind",
  "status": "scheduled | due | running | published | failed | check | missed | cancelled",
  "publishedUrl": "发布后的笔记链接",
  "publishedAt": "实际发布时间",
  "error": "失败原因"
}
```

发布完成后**必须**更新对应条目（只改这几个字段，保留其他字段）：

- 成功：`status` 改为 `published`，填 `publishedUrl`（拿不到就留空）和 `publishedAt`；同时把笔记 `meta.json` 的 `status` 改为 `published`，填 `publishedUrl`、`publishedAt`。
- 失败：`status` 改为 `failed`，`error` 写清楚原因和停在哪一步。
- 不确定是否发出去了：`status` 改为 `check`，`error` 写明情况，让用户去确认。**不要为了确认而重复发布。**

## 发布步骤

需要浏览器控制能力（Playwright MCP、Claude in Chrome、或你自带的浏览器 / 电脑控制工具）。**没有这类工具时，不要尝试其他方式**：把条目改为 `failed`，`error` 写「agent 没有浏览器控制能力，请手动发布或运行 browser-setup」，并在回复中说明。

1. **检查素材**：读 `meta.json`、`content.md`，确认标题 ≤20 字、正文 ≤1000 字；`coverMode` 为 `template`（或没有该字段）时要有 `cover.png`，为 `first` 时要至少有一张配图。图片总数不超过 18 张。缺东西就停止并标记 `failed`。
2. **登录检查与账号核对**：按 `browser.md` 执行；未登录超时或账号不一致时，标记 `failed` 并写明原因。
   然后打开发布页 `https://creator.xiaohongshu.com/publish/publish`。
3. **上传图文**：选择「上传图文」，**按以下顺序**上传：
   - `coverMode` 不是 `first` 时，第一张是 `cover.png`；
   - 然后按 `meta.json` 的 `media` 数组顺序上传 `images/` 里的文件（没有 `media` 字段时按文件名顺序）。
   - **实况图**（`media` 中带 `video` 的项）：在上传区寻找「实况图 / Live 图」相关的入口，按页面要求同时提供静态图和对应的视频。**如果网页版找不到实况图的上传方式，停止发布**，标记 `failed`，`error` 写「网页版不支持实况图，请在手机 App 发布（可在工作台下载全部素材）」——不要把实况图降级成普通图片发出去。
   - 上传完成后核对页面上的图片数量和顺序。
4. **填写内容**：标题填 `meta.json` 的 `title`；正文填 `content.md`；话题在正文末尾逐个输入 `#话题` 并从下拉中选择匹配项。
5. **可见范围**：`meta.json` 的 `visibility` 为 `private` 时，在发布页的权限 / 可见范围设置里选择「仅自己可见」；没有该字段或为 `public` 时保持默认公开。找不到这个设置就停止，标记 `failed`，不要以公开方式发出。
6. **发布前核对**：截图或读取页面，确认标题、正文、图片数量都正确。
7. **点击发布**，等待页面出现成功提示。尽量从「笔记管理」里找到刚发布的笔记链接。
8. **回写结果**（见上）。回复用户：是否成功、笔记链接、遇到的问题。

## 页面经验（2026-10 实测，页面改版后可能失效）

- 发布前先确认当前登录的账号（小红书号）和要发布的账号一致。
- 「发布」按钮在一个封闭的 Shadow DOM 自定义元素（`xhs-publish-btn`）里，常规选择器找不到，可以先截图确认位置，再按坐标点击。
- 「可见范围」下拉框要点击选择框本身才会展开。
- 话题：在正文末尾输入 `#测试` 后，从下拉列表中选择完全匹配的那一项，会变成话题标签。
- 发布成功后，在「笔记管理」（`https://creator.xiaohongshu.com/new/note-manager`）里可以找到新笔记的 noteId，链接格式为 `https://www.xiaohongshu.com/explore/<noteId>`。新笔记会先进入「审核中」状态。

## 异常处理

- 出现验证码、滑块、"操作频繁"、账号异常提示：立即停止，标记 `failed`，请用户处理。
- 页面结构和描述不一致：凭页面上的文字找对应按钮；找不到就停止并说明，不要乱点。
- 上传失败或网络错误：最多重试 1 次。
- 任何时候不确定内容是否已经发出：标记 `check`，不要再点发布。

## 手动发布

用户选择「到点提醒我」时由用户自己发布，工作台的「手动发布助手」提供复制标题 / 正文、下载封面、打开创作者中心等功能，你不需要参与。
