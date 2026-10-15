// 文案检查：平台字数限制 + 常见违禁词 / 风险词。前端实时检查，scripts/workbench.mjs lint 也复用这份词表。
// 词表只是常见风险提示，不等于平台完整规则；可以按需增补。

export const LIMITS = { title: 20, body: 1000, tags: 10 };

export const RULES = [
  {
    category: '绝对化用语',
    level: 'error',
    tip: '广告法禁止绝对化用语，改成具体描述（如"我用过最顺手的"→"我回购了 3 次"）',
    words: ['最好', '最佳', '最强', '最低价', '最便宜', '最优', '全网最', '史上最', '第一', '唯一', '顶级', '极致', '国家级', '世界级', '100%', '百分百', '绝对', '永久', '万能', '首个', '首选', '独家', '王牌', '销量冠军'],
  },
  {
    category: '医疗功效',
    level: 'error',
    tip: '非医疗产品不能宣称治疗功效，改成使用感受',
    words: ['治疗', '治愈', '根治', '药效', '疗效', '消炎', '抗癌', '防癌', '无副作用', '包治', '处方', '排毒', '祛病', '降血压', '降血糖'],
  },
  {
    category: '虚假承诺',
    level: 'error',
    tip: '避免收益、效果承诺，容易被判定虚假宣传',
    words: ['稳赚', '躺赚', '零风险', '保本', '包过', '一夜暴富', '月入过万', '月入十万', '立竿见影', '7天见效', '速效', '秒杀全网'],
  },
  {
    category: '站外引流',
    level: 'warn',
    tip: '小红书限制导流到站外，可能被限流',
    words: ['微信', 'vx', 'wx', '威信', '加v', '公众号', '二维码', '淘宝', '拼多多', '抖音', '私我', '私信领取', '戳链接'],
  },
  {
    category: '诱导互动',
    level: 'warn',
    tip: '诱导点赞关注可能被判定违规，换成自然的互动引导',
    words: ['求赞', '互赞', '互关', '互粉', '点赞关注', '转发抽奖', '关注领取'],
  },
];

export function countChars(s) {
  return [...String(s || '')].length;
}

/** 返回 { issues: [{ level, category, word, where, tip }], titleLen, bodyLen } */
export function lint({ title = '', body = '', tags = [] } = {}) {
  const issues = [];
  const titleLen = countChars(title);
  const bodyLen = countChars(body);
  if (!String(title).trim()) issues.push({ level: 'warn', category: '字数', where: '标题', tip: '还没有标题' });
  if (titleLen > LIMITS.title) issues.push({ level: 'error', category: '字数', where: '标题', tip: `标题 ${titleLen} 字，超过 ${LIMITS.title} 字上限` });
  if (bodyLen > LIMITS.body) issues.push({ level: 'error', category: '字数', where: '正文', tip: `正文 ${bodyLen} 字，超过 ${LIMITS.body} 字上限` });
  if (tags.length > LIMITS.tags) issues.push({ level: 'warn', category: '话题', where: '话题', tip: `话题标签 ${tags.length} 个，建议不超过 ${LIMITS.tags} 个` });

  for (const [where, text] of [['标题', title], ['正文', body], ['话题', tags.join(' ')]]) {
    const lower = String(text).toLowerCase();
    for (const rule of RULES) {
      for (const w of rule.words) {
        if (lower.includes(w.toLowerCase())) issues.push({ level: rule.level, category: rule.category, word: w, where, tip: rule.tip });
      }
    }
  }
  return { issues, titleLen, bodyLen };
}
