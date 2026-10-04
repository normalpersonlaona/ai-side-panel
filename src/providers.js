/**
 * 预置服务商 —— 全部走 OpenAI 兼容协议：POST {baseUrl}/chat/completions
 *
 * vision 字段：
 *   true  = 确认支持图片输入
 *   false = 确认不支持（界面上会隐藏图片入口，省得你白传）
 *   null  = 拿不准，界面按「允许尝试」处理
 *
 * ⚠️ 模型名是会过时的。设置页允许你直接把模型名改成任意字符串，
 *    别被下面这份列表框住。baseUrl 同理。
 *
 * 关于 MiMo：官方开放平台按量付费和 Token Plan 是两套 base_url，
 * 互不通用，所以这里拆成了两条。
 */

export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    // 注意：DeepSeek 从 V4 起已经有原生多模态了（V4.1-Flash 能看图），
    // 所以这里不写死 false —— 拿不准就给 null，界面按「允许」处理。
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', vision: null },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', vision: null },
    ],
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-4-plus', label: 'GLM-4-Plus', vision: false },
      { id: 'glm-4-flash', label: 'GLM-4-Flash', vision: false },
      { id: 'glm-4v-plus', label: 'GLM-4V-Plus', vision: true },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/',
    models: [
      { id: 'qwen-plus', label: 'Qwen-Plus', vision: false },
      { id: 'qwen-max', label: 'Qwen-Max', vision: false },
      { id: 'qwen-vl-max', label: 'Qwen-VL-Max', vision: true },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI GPT',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', vision: true },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', vision: true },
    ],
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    models: [
      { id: 'mimo-v2.6-pro', label: 'MiMo-V2.6-Pro', vision: null },
      { id: 'mimo-v2.6-flash', label: 'MiMo-V2.6-Flash', vision: null },
      { id: 'mimo-v2.6-pro-ultraspeed', label: 'MiMo-V2.6-Pro-Ultraspeed', vision: null },
    ],
  },
  {
    id: 'mimo-plan',
    name: '小米 MiMo · Token Plan 套餐',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/plan-manage',
    models: [
      { id: 'mimo-v2.6-pro', label: 'MiMo-V2.6-Pro', vision: null },
      { id: 'mimo-v2.6-flash', label: 'MiMo-V2.6-Flash', vision: null },
    ],
  },
];

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

/**
 * 模型能不能看图。
 * 用户自定义的模型名查不到时返回 null（= 拿不准，放行）。
 */
export function modelVision(provider, modelId) {
  if (!provider) return null;
  const m = (provider.models || []).find((x) => x.id === modelId);
  return m ? m.vision : null;
}

/**
 * 从模型名猜能不能看图 —— 只用于「自动拉取」回来的、预置表里没有的模型。
 *
 * 猜错不要紧：返回 null 就是「拿不准」，界面按允许处理，
 * 顶多是你传了图模型说它不认识，不会把能看图的模型给禁掉。
 */
export function guessVision(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return null;

  // 只在「有把握」时返回 true；猜不出来一律 null（= 允许尝试）。
  //
  // ⚠️ 绝对不要按厂商一刀切说「这家不能看图」——
  // DeepSeek 就是这么被打脸过一次：V4.1-Flash 已经支持原生多模态了。
  // 模型名和能力的对应关系变得比你想象的快，宁可放行让它报错，
  // 也别把一个能看图的模型给锁上。
  // 名字里带 vl / vision / omni / multimodal 的，比如 qwen-vl-max
  if (/(^|[-_/.])(vl|vision|omni|multimodal)([-_/.]|$)/.test(s)) return true;

  // 数字后面跟 v 的写法，比如 glm-4v-plus
  if (/\d+v([-_/.]|$)/.test(s)) return true;

  // 确定看得见的几个系列
  if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt-4o/.test(s)) return true;
  if (/^claude/.test(s)) return true; // Claude 3 起全系支持；名字里带 2 的老古董很少见了
  if (/gemini|gemma-3/.test(s)) return true;

  return null;
}
