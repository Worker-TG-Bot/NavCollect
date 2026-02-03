
/**
 * NavCollect - 个人网站导航收藏系统
 * Cloudflare Worker 单文件实现 v4.4
 * 功能：SPA模式、深浅色主题、后台配置管理、多用户支持、页脚配置、频道消息收藏
 * 环境变量：只需要 ADMIN_PASSWORD
 * 其他配置存储在 KV 中
 */

// ============== 工具函数 ==============

function generateId() {
  const now = new Date();
  const pad = (n, len = 2) => n.toString().padStart(len, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Math.random().toString(36).substring(2, 6);
  return `${timestamp}-${random}`;
}

function getTimestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).replace(' ', 'T') + '+08:00';
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  return timestamp.replace('T', ' ').split('+')[0];
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  return formatTime(timestamp).split(' ')[0];
}

function parseTags(text) {
  const hashTags = text.match(/#[\w\u4e00-\u9fa5]+/g) || [];
  const tags = hashTags.map(t => t.slice(1).toLowerCase());
  return [...new Set(tags)];
}

function removeTagsFromContent(text) {
  return text.replace(/#[\w\u4e00-\u9fa5]+/g, '').trim();
}

function verifyToken(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/admin_token=([^;]+)/);
  if (!match) return false;
  const expectedToken = btoa(env.ADMIN_PASSWORD + '_navcollect_v4');
  return match[1] === expectedToken;
}

function generateToken(env) {
  return btoa(env.ADMIN_PASSWORD + '_navcollect_v4');
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateWebhookSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ============== Markdown 处理 ==============

/**
 * 核心算法：支持嵌套的实体还原
 */
function restoreEntities(text, entities, mode = 'std') {
  if (!text) return "";
  if (!entities || entities.length === 0) return mode === 'tg' ? escapeV2(text) : text;

  let openTags = Array.from({ length: text.length + 1 }, () => []);
  let closeTags = Array.from({ length: text.length + 1 }, () => []);

  for (const entity of entities) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    openTags[start].push(entity);
    closeTags[end].push(entity);
  }

  let result = "";
  let activeStack = [];

  for (let i = 0; i <= text.length; i++) {
    if (closeTags[i].length > 0) {
      let toClose = [...closeTags[i]];
      while (toClose.length > 0) {
        const entity = activeStack.pop();
        result += getTag(entity, 'close', mode);
        const index = toClose.indexOf(entity);
        if (index !== -1) toClose.splice(index, 1);
      }
    }
    if (openTags[i].length > 0) {
      const sortedOpen = openTags[i].sort((a, b) => b.length - a.length);
      for (const entity of sortedOpen) {
        result += getTag(entity, 'open', mode);
        activeStack.push(entity);
      }
    }
    if (i < text.length) {
      result += (mode === 'tg') ? escapeV2(text[i]) : text[i];
    }
  }
  return result;
}

function getTag(entity, type, mode) {
  const isOp = type === 'open';
  const isTg = mode === 'tg';
  switch (entity.type) {
    case "bold": return isTg ? "*" : "**";
    case "italic": return isTg ? "_" : "*";
    case "underline": return isTg ? "__" : (isOp ? "<u>" : "</u>");
    case "strikethrough": return isTg ? "~" : "~~";
    case "spoiler": return isTg ? "||" : (isOp ? "<mark>" : "</mark>");
    case "code": return "`";
    case "pre": return isOp ? "```" + (entity.language || "") + "\n" : "\n```";
    case "text_link": return isOp ? "[" : `](${entity.url})`;
    case "text_mention": return isOp ? "[" : `](tg://user?id=${entity.user.id})`;
    case "blockquote":
    case "expandable_blockquote":
      if (isTg) return isOp ? "> " : "";
      return isOp ? "> " : "\n";
    default: return "";
  }
}

function escapeV2(text) {
  return text ? text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&') : "";
}

// ============== JSON 响应工具函数 ==============

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function successResponse(data = {}) {
  return jsonResponse({ success: true, ...data });
}

// ============== Favicon 服务配置 ==============

const FAVICON_SERVICES = {
  google: {
    name: 'Google',
    getUrl: (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    description: '稳定，但国内可能无法访问'
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    getUrl: (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    description: '国际通用，速度较快'
  },
  favicon_im: {
    name: 'Favicon.im',
    getUrl: (domain) => `https://favicon.im/${domain}`,
    description: '备用服务'
  },
  yandex: {
    name: 'Yandex',
    getUrl: (domain) => `https://favicon.yandex.net/favicon/${domain}`,
    description: '俄罗斯服务，国内可访问'
  },
  icon_horse: {
    name: 'Icon.Horse',
    getUrl: (domain) => `https://icon.horse/icon/${domain}`,
    description: '高质量图标服务'
  }
};

// 验证响应是否为有效图片
function isValidImageResponse(response, buffer) {
  const contentType = response.headers.get('content-type') || '';
  const validTypes = ['image/', 'application/octet-stream'];
  const isValidType = validTypes.some(t => contentType.includes(t)) || contentType.includes('ico');
  const isValidSize = buffer.byteLength > 100 && buffer.byteLength < 100000;
  return isValidType && isValidSize;
}

// 使用指定服务获取 Favicon
async function fetchFaviconWithService(url, serviceKey) {
  if (!url) return { success: false, error: 'URL为空' };
  
  try {
    const domain = new URL(url).hostname;
    const service = FAVICON_SERVICES[serviceKey];
    
    if (!service) {
      return { success: false, error: '未知的服务' };
    }
    
    const faviconUrl = service.getUrl(domain);
    
    const response = await fetch(faviconUrl, {
      cf: { cacheTtl: 86400 },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    
    const buffer = await response.arrayBuffer();
    
    if (!isValidImageResponse(response, buffer)) {
      return { success: false, error: '无效的图片响应' };
    }
    
    const contentType = response.headers.get('content-type') || 'image/x-icon';
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    
    return {
      success: true,
      favicon: `data:${contentType};base64,${base64}`,
      size: buffer.byteLength,
      contentType
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 测试所有 Favicon 服务
async function testAllFaviconServices(url) {
  if (!url) return { error: 'URL为空' };
  
  let domain;
  try {
    domain = new URL(url).hostname;
  } catch (e) {
    return { error: '无效的URL' };
  }
  
  const results = {};
  
  await Promise.all(
    Object.keys(FAVICON_SERVICES).map(async (key) => {
      const startTime = Date.now();
      const result = await fetchFaviconWithService(url, key);
      const duration = Date.now() - startTime;
      
      results[key] = {
        ...result,
        duration,
        name: FAVICON_SERVICES[key].name,
        description: FAVICON_SERVICES[key].description
      };
    })
  );
  
  return { domain, results };
}

// 自动选择最佳服务获取 Favicon（用于默认情况）
async function fetchFavicon(url, preferredService = null) {
  if (!url) return '';
  
  // 如果指定了服务，优先使用
  if (preferredService && FAVICON_SERVICES[preferredService]) {
    const result = await fetchFaviconWithService(url, preferredService);
    if (result.success) {
      return result.favicon;
    }
  }
  
  // 否则按顺序尝试所有服务
  const serviceOrder = ['duckduckgo', 'yandex', 'icon_horse', 'google', 'favicon_im'];
  
  for (const serviceKey of serviceOrder) {
    const result = await fetchFaviconWithService(url, serviceKey);
    if (result.success) {
      return result.favicon;
    }
  }
  
  return '';
}

// ============== KV 操作 ==============

async function getCollections(env) {
  try {
    const data = await env.NAV_KV.get('collections', 'json');
    return data || [];
  } catch (e) {
    console.error('getCollections error:', e);
    return [];
  }
}

async function saveCollections(env, collections) {
  try {
    await env.NAV_KV.put('collections', JSON.stringify(collections));
    return true;
  } catch (e) {
    console.error('saveCollections error:', e);
    return false;
  }
}

async function getMetadata(env) {
  try {
    const data = await env.NAV_KV.get('metadata', 'json');
    return data || { total_count: 0, last_updated: null, tag_list: [], source_list: [], version: 0 };
  } catch (e) {
    return { total_count: 0, last_updated: null, tag_list: [], source_list: [], version: 0 };
  }
}

async function saveMetadata(env, metadata) {
  try {
    metadata.version = (metadata.version || 0) + 1;
    await env.NAV_KV.put('metadata', JSON.stringify(metadata));
  } catch (e) {
    console.error('saveMetadata error:', e);
  }
}

async function getSiteConfig(env) {
  try {
    const data = await env.NAV_KV.get('site_config', 'json');
    return data || getDefaultSiteConfig();
  } catch (e) {
    return getDefaultSiteConfig();
  }
}

function getDefaultSiteConfig() {
  return {
    title: 'NavCollect',
    description: '个人网站导航收藏系统',
    logo: '',
    logo_type: 'emoji',
    logo_emoji: '📚',
    theme: 'light',
    footer_links: []
  };
}

async function saveSiteConfig(env, config) {
  try {
    await env.NAV_KV.put('site_config', JSON.stringify(config));
    return true;
  } catch (e) {
    console.error('saveSiteConfig error:', e);
    return false;
  }
}

async function getBotConfig(env) {
  try {
    const data = await env.NAV_KV.get('bot_config', 'json');
    return data || getDefaultBotConfig();
  } catch (e) {
    return getDefaultBotConfig();
  }
}

function getDefaultBotConfig() {
  return {
    bot_token: '',
    webhook_secret: '',
    allowed_users: '',
    allowed_channels: '',
    webhook_url: '',
    webhook_set: false
  };
}

async function saveBotConfig(env, config) {
  try {
    await env.NAV_KV.put('bot_config', JSON.stringify(config));
    return true;
  } catch (e) {
    console.error('saveBotConfig error:', e);
    return false;
  }
}

async function getTagIds(env, tag) {
  try {
    const data = await env.NAV_KV.get(`tags_${tag}`, 'json');
    return data || [];
  } catch (e) {
    return [];
  }
}

async function saveTagIds(env, tag, ids) {
  try {
    if (ids.length === 0) {
      await env.NAV_KV.delete(`tags_${tag}`);
    } else {
      await env.NAV_KV.put(`tags_${tag}`, JSON.stringify(ids));
    }
  } catch (e) {
    console.error('saveTagIds error:', e);
  }
}

// ============== 数据操作 ==============

async function addItem(env, tags, content, source = 'web', sourceInfo = null, telegramMsgInfo = null) {
  const id = generateId();
  const item = {
    id,
    tags,
    content,
    source,
    source_info: sourceInfo,
    telegram_msg: telegramMsgInfo,
    timestamp: getTimestamp()
  };
  
  const collections = await getCollections(env);
  collections.push(item);
  await saveCollections(env, collections);
  
  for (const tag of tags) {
    const tagIds = await getTagIds(env, tag);
    tagIds.push(id);
    await saveTagIds(env, tag, tagIds);
  }
  
  await updateMetadataAfterChange(env, collections, tags, sourceInfo);
  
  return item;
}

// 根据 Telegram 消息 ID 查找收藏项
async function findItemByTelegramMsg(env, chatId, messageId) {
  const collections = await getCollections(env);
  return collections.find(item => 
    item.telegram_msg && 
    item.telegram_msg.chat_id === chatId && 
    item.telegram_msg.message_id === messageId
  );
}

// 根据 Telegram 消息 ID 更新收藏项
async function updateItemByTelegramMsg(env, chatId, messageId, newTags, newContent) {
  const collections = await getCollections(env);
  const index = collections.findIndex(item => 
    item.telegram_msg && 
    item.telegram_msg.chat_id === chatId && 
    item.telegram_msg.message_id === messageId
  );
  
  if (index === -1) return null;
  
  const oldItem = collections[index];
  const oldTags = oldItem.tags;
  
  // 移除旧标签关联
  for (const tag of oldTags) {
    const tagIds = await getTagIds(env, tag);
    const newTagIds = tagIds.filter(tid => tid !== oldItem.id);
    await saveTagIds(env, tag, newTagIds);
  }
  
  // 更新项目
  collections[index] = {
    ...oldItem,
    tags: newTags,
    content: newContent,
    timestamp: getTimestamp(),
    edited: true
  };
  await saveCollections(env, collections);
  
  // 添加新标签关联
  for (const tag of newTags) {
    const tagIds = await getTagIds(env, tag);
    if (!tagIds.includes(oldItem.id)) {
      tagIds.push(oldItem.id);
    }
    await saveTagIds(env, tag, tagIds);
  }
  
  await updateMetadataAfterChange(env, collections);
  
  return collections[index];
}

async function deleteItem(env, id) {
  const collections = await getCollections(env);
  const index = collections.findIndex(item => item.id === id);
  if (index === -1) return false;
  
  const item = collections[index];
  collections.splice(index, 1);
  await saveCollections(env, collections);
  
  for (const tag of item.tags) {
    const tagIds = await getTagIds(env, tag);
    const newTagIds = tagIds.filter(tid => tid !== id);
    await saveTagIds(env, tag, newTagIds);
  }
  
  await updateMetadataAfterChange(env, collections);
  
  return true;
}

async function editItem(env, id, newTags, newContent) {
  const collections = await getCollections(env);
  const index = collections.findIndex(item => item.id === id);
  if (index === -1) return null;
  
  const oldItem = collections[index];
  const oldTags = oldItem.tags;
  
  for (const tag of oldTags) {
    const tagIds = await getTagIds(env, tag);
    const newTagIds = tagIds.filter(tid => tid !== id);
    await saveTagIds(env, tag, newTagIds);
  }
  
  collections[index] = {
    ...oldItem,
    tags: newTags,
    content: newContent,
    timestamp: getTimestamp()
  };
  await saveCollections(env, collections);
  
  for (const tag of newTags) {
    const tagIds = await getTagIds(env, tag);
    if (!tagIds.includes(id)) {
      tagIds.push(id);
    }
    await saveTagIds(env, tag, tagIds);
  }
  
  await updateMetadataAfterChange(env, collections);
  
  return collections[index];
}

async function updateMetadataAfterChange(env, collections, newTags = [], sourceInfo = null) {
  const metadata = await getMetadata(env);
  metadata.total_count = collections.length;
  metadata.last_updated = getTimestamp();
  
  // 更新标签列表
  const allTags = new Set();
  collections.forEach(c => c.tags.forEach(t => allTags.add(t)));
  metadata.tag_list = [...allTags];
  
  // 更新来源列表
  if (sourceInfo) {
    let sourceKey = '';
    if (sourceInfo.username) {
      sourceKey = sourceInfo.username;
    } else if (sourceInfo.channel_title) {
      sourceKey = `channel_${sourceInfo.channel_id}`;
    } else if (sourceInfo.user_id) {
      sourceKey = `user_${sourceInfo.user_id}`;
    }
    
    if (!metadata.source_list) metadata.source_list = [];
    if (sourceKey && !metadata.source_list.find(s => s.key === sourceKey)) {
      metadata.source_list.push({
        key: sourceKey,
        name: sourceInfo.username || sourceInfo.channel_title || sourceInfo.first_name,
        user_id: sourceInfo.user_id,
        channel_id: sourceInfo.channel_id,
        type: sourceInfo.channel_id ? 'channel' : 'user'
      });
    }
  }
  
  await saveMetadata(env, metadata);
}

// ============== Telegram API ==============

async function callTelegramApi(botToken, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function sendMessage(botToken, chatId, text, options = {}) {
  return callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options
  });
}

async function editMessageText(botToken, chatId, messageId, text, options = {}) {
  return callTelegramApi(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options
  });
}

async function answerCallbackQuery(botToken, callbackQueryId, text = '') {
  return callTelegramApi(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text
  });
}

// ============== 权限验证 ==============

function isAllowedUser(userId, allowedUsers) {
  if (!allowedUsers) return false;
  const userIds = allowedUsers.split(',').map(id => id.trim());
  return userIds.includes(userId.toString());
}

function isAllowedChannel(channelId, allowedChannels) {
  if (!allowedChannels) return false;
  const channelIds = allowedChannels.split(',').map(id => id.trim());
  return channelIds.includes(channelId.toString());
}

// ============== Telegram Bot 处理 ==============

async function handleTelegramUpdate(env, update, botConfig) {
  console.log('Received update:', JSON.stringify(update));
  
  if (update.callback_query) {
    return handleCallbackQuery(env, update.callback_query, botConfig);
  }
  
  // 处理私聊中编辑的消息
  if (update.edited_message) {
    return handleEditedMessage(env, update.edited_message, botConfig);
  }
  
  // 处理频道中编辑的消息
  if (update.edited_channel_post) {
    return handleEditedChannelMessage(env, update.edited_channel_post, botConfig);
  }
  
  // 处理频道消息
  if (update.channel_post) {
    return handleChannelMessage(env, update.channel_post, botConfig);
  }
  
  if (update.message) {
    return handleTelegramMessage(env, update.message, botConfig);
  }
  
  return { ok: true };
}

// 处理 Telegram 私聊中编辑的消息
async function handleEditedMessage(env, message, botConfig) {
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const userId = message.from.id.toString();
  
  console.log('Edited message from:', userId, 'message_id:', messageId);
  
  // 验证用户权限
  if (!isAllowedUser(userId, botConfig.allowed_users)) {
    return { ok: true };
  }
  
  // 查找对应的收藏项
  const existingItem = await findItemByTelegramMsg(env, chatId, messageId);
  if (!existingItem) {
    console.log('No matching item found for edited message');
    return { ok: true };
  }
  
  // 提取新内容并转换为标准 Markdown
  let content = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  
  if (entities.length > 0) {
    content = restoreEntities(content, entities, 'std');
  }
  
  if (!content.trim()) {
    return { ok: true };
  }
  
  // 解析标签（提取但不删除原文中的标签）
  const tags = parseTags(content);
  const finalTags = tags.length > 0 ? tags : existingItem.tags;
  
  // 更新收藏（保留原文中的标签）
  const updatedItem = await updateItemByTelegramMsg(env, chatId, messageId, finalTags, content);
  
  if (updatedItem) {
    const tagsText = finalTags.map(t => `#${t}`).join(' ');
    const previewContent = content.substring(0, 60).replace(/\n/g, ' ');
    
    await sendMessage(botConfig.bot_token, chatId,
      `🔄 <b>收藏已自动更新！</b>\n\n🏷️ ${tagsText}\n📝 ${escapeHtml(previewContent)}${content.length > 60 ? '...' : ''}\n\n<i>💡 编辑原消息会自动同步更新</i>`,
      {
        reply_to_message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: '📄 查看详情', callback_data: `view_${updatedItem.id}` },
            { text: '🏠 主菜单', callback_data: 'act_menu' }
          ]]
        }
      }
    );
  }
  
  return { ok: true };
}

// 处理 Telegram 频道中编辑的消息
async function handleEditedChannelMessage(env, message, botConfig) {
  const chatId = message.chat.id;
  const messageId = message.message_id;
  
  console.log('Edited channel post from:', chatId, 'message_id:', messageId);
  
  // 验证频道权限
  if (!isAllowedChannel(chatId.toString(), botConfig.allowed_channels)) {
    console.log('Channel not allowed:', chatId);
    return { ok: true };
  }
  
  // 查找对应的收藏项
  const existingItem = await findItemByTelegramMsg(env, chatId, messageId);
  if (!existingItem) {
    console.log('No matching item found for edited channel post');
    return { ok: true };
  }
  
  // 提取新内容并转换为标准 Markdown
  let content = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  
  if (entities.length > 0) {
    content = restoreEntities(content, entities, 'std');
  }
  
  if (!content.trim()) {
    return { ok: true };
  }
  
  // 解析标签（提取但不删除原文中的标签）
  const tags = parseTags(content);
  const finalTags = tags.length > 0 ? tags : existingItem.tags;
  
  // 更新收藏（保留原文中的标签）
  await updateItemByTelegramMsg(env, chatId, messageId, finalTags, content);
  
  console.log('Channel post updated silently:', messageId);
  
  return { ok: true };
}

// 处理 Telegram 频道消息
async function handleChannelMessage(env, message, botConfig) {
  const chatId = message.chat.id;
  const chatTitle = message.chat.title;
  
  console.log('Channel post from:', chatId, 'title:', chatTitle);
  
  // 验证频道权限
  if (!isAllowedChannel(chatId.toString(), botConfig.allowed_channels)) {
    console.log('Channel not allowed:', chatId);
    return { ok: true };
  }
  
  // 提取内容并转换为标准 Markdown
  let content = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  
  if (entities.length > 0) {
    content = restoreEntities(content, entities, 'std');
  }
  
  if (!content.trim()) {
    return { ok: true };
  }
  
  // 解析标签（提取但不删除原文中的标签）
  const tags = parseTags(content);
  
  // 默认标签 + 频道标签
  const finalTags = tags.length > 0 ? tags : ['channel'];
  
  // 添加频道名作为标签
  if (chatTitle) {
    const channelTag = chatTitle.toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (channelTag) {
      finalTags.push(`channel_${channelTag}`);
    }
  }
  
  // 保存 Telegram 消息信息
  const telegramMsgInfo = {
    chat_id: chatId,
    message_id: message.message_id,
    chat_type: 'channel',
    channel_title: chatTitle
  };
  
  // 保存来源信息
  const sourceInfo = {
    channel_id: chatId.toString(),
    channel_title: chatTitle,
    channel_username: message.chat.username || null,
    type: 'channel'
  };
  
  // 添加收藏项（保留原文中的标签）
  const item = await addItem(env, finalTags, content, 'telegram_channel', sourceInfo, telegramMsgInfo);
  
  console.log('Channel post saved:', item.id);
  
  return { ok: true };
}

// 处理 Telegram 私聊消息
async function handleTelegramMessage(env, message, botConfig) {
  const chatId = message.chat.id;
  const userId = message.from.id.toString();
  const text = message.text || '';
  
  console.log('Message from:', userId, 'Allowed:', botConfig.allowed_users);
  
  if (!isAllowedUser(userId, botConfig.allowed_users)) {
    await sendMessage(botConfig.bot_token, chatId, '⛔ 无权限访问');
    return { ok: true };
  }
  
  const stateKey = `state_${userId}`;
  let state = null;
  try {
    state = await env.NAV_KV.get(stateKey, 'json');
  } catch (e) {
    console.error('Get state error:', e);
  }
  
  if (state && state.action === 'waiting_add') {
    await env.NAV_KV.delete(stateKey);
    return handleAddContent(env, chatId, message, botConfig);
  }
  
  if (state && state.action === 'waiting_edit') {
    await env.NAV_KV.delete(stateKey);
    return handleEditContent(env, chatId, message, state.itemId, botConfig);
  }
  
  if (text === '/start' || text === '/menu') {
    return sendMainMenu(env, chatId, false, null, botConfig);
  }
  
  if (text === '/help') {
    return sendMessage(botConfig.bot_token, chatId, 
      '📖 <b>使用帮助</b>\n\n' +
      '<b>📥 添加收藏</b>\n' +
      '• 发送 /start 或 /menu 打开主菜单\n' +
      '• 点击 [添加] 后发送内容（支持 #标签）\n' +
      '• 支持转发消息自动收藏\n' +
      '• 支持代码块（用```包裹）\n\n' +
      '<b>📢 频道收藏</b>\n' +
      '• 将Bot添加为频道管理员\n' +
      '• 在频道中发送消息自动收藏\n' +
      '• 编辑频道消息自动更新收藏\n' +
      '• 支持 #标签 自动识别\n\n' +
      '<b>✏️ 编辑收藏</b>\n' +
      '• 直接编辑你发送的原消息\n' +
      '• 系统会自动同步更新收藏内容\n' +
      '• 修改标签请在内容中添加 #新标签\n\n' +
      '<b>💡 示例</b>\n' +
      '<code>#tech #工具 https://example.com 好用的工具</code>'
    );
  }
  
  // 所有其他非命令消息都保存
  return handleAddContent(env, chatId, message, botConfig);
}

async function sendMainMenu(env, chatId, isEdit = false, messageId = null, botConfig) {
  const metadata = await getMetadata(env);
  const lastUpdate = metadata.last_updated ? formatTime(metadata.last_updated) : '暂无';
  const text = `📚 <b>NavCollect 导航收藏</b>\n\n` +
    `📊 总收藏: <b>${metadata.total_count || 0}</b> 条\n` +
    `🏷️ 标签数: <b>${(metadata.tag_list || []).length}</b> 个\n` +
    `📢 频道支持: <b>已启用</b>\n` +
    `🕐 最后更新: ${lastUpdate}\n\n` +
    `请选择操作：`;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '➕ 添加', callback_data: 'act_add' },
        { text: '🕐 最近10条', callback_data: 'act_recent' }
      ],
      [
        { text: '📋 所有收藏', callback_data: 'act_all_0' },
        { text: '🏷️ 标签列表', callback_data: 'act_tags' }
      ]
    ]
  };
  
  if (isEdit && messageId) {
    return editMessageText(botConfig.bot_token, chatId, messageId, text, { reply_markup: keyboard });
  } else {
    return sendMessage(botConfig.bot_token, chatId, text, { reply_markup: keyboard });
  }
}

async function handleCallbackQuery(env, query, botConfig) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id.toString();
  const data = query.data;
  
  console.log('Callback query from:', userId, 'data:', data);
  
  if (!isAllowedUser(userId, botConfig.allowed_users)) {
    await answerCallbackQuery(botConfig.bot_token, query.id, '⛔ 无权限');
    return { ok: true };
  }
  
  await answerCallbackQuery(botConfig.bot_token, query.id);
  
  if (!data) {
    console.error('No callback data');
    return { ok: true };
  }
  
  if (data === 'act_add') {
    await env.NAV_KV.put(`state_${userId}`, JSON.stringify({ action: 'waiting_add' }), { expirationTtl: 300 });
    return editMessageText(botConfig.bot_token, chatId, messageId,
      '📝 <b>添加收藏</b>\n\n请直接发送内容，支持：\n• #标签 + 链接/文本\n• 转发其他消息\n• 代码块 (用```包裹)\n• 在授权频道中发送消息自动收藏',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'act_menu' }]] } }
    );
  }
  
  if (data === 'act_menu') {
    await env.NAV_KV.delete(`state_${userId}`);
    return sendMainMenu(env, chatId, true, messageId, botConfig);
  }
  
  if (data === 'act_recent') {
    const collections = await getCollections(env);
    const recent = collections.slice(-10).reverse();
    
    if (recent.length === 0) {
      return editMessageText(botConfig.bot_token, chatId, messageId, '📭 暂无收藏', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 主菜单', callback_data: 'act_menu' }]] }
      });
    }
    
    let text = '🕐 <b>最近 10 条收藏</b>\n\n';
    const buttons = [];
    
    recent.forEach((item, index) => {
      const tags = item.tags.map(t => `#${t}`).join(' ');
      const content = item.content.length > 60 ? item.content.substring(0, 60) + '...' : item.content;
      const cleanContent = content.replace(/\n/g, ' ').replace(/```[\s\S]*?```/g, '[代码块]');
      const time = formatRelativeTime(item.timestamp);
      const sourceIcon = item.source === 'telegram_channel' ? '📢' : '👤';
      text += `<b>${index + 1}.</b> ${sourceIcon} ${tags}\n${escapeHtml(cleanContent)}\n<i>${time}</i>\n\n`;
      
      buttons.push([
        { text: `📄 查看 ${index + 1}`, callback_data: `view_${item.id}` },
        { text: `✏️`, callback_data: `edit_${item.id}` },
        { text: `🗑️`, callback_data: `delask_${item.id}` }
      ]);
    });
    
    buttons.push([{ text: '🏠 主菜单', callback_data: 'act_menu' }]);
    
    return editMessageText(botConfig.bot_token, chatId, messageId, text, { reply_markup: { inline_keyboard: buttons } });
  }
  
  if (data.startsWith('act_all_')) {
    const page = parseInt(data.replace('act_all_', '')) || 0;
    const pageSize = 8;
    const collections = await getCollections(env);
    const reversed = [...collections].reverse();
    const total = reversed.length;
    const totalPages = Math.ceil(total / pageSize);
    const items = reversed.slice(page * pageSize, (page + 1) * pageSize);
    
    if (items.length === 0) {
      return editMessageText(botConfig.bot_token, chatId, messageId, '📭 暂无收藏', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 主菜单', callback_data: 'act_menu' }]] }
      });
    }
    
    let text = `📋 <b>所有收藏</b> (第 ${page + 1}/${totalPages || 1} 页，共 ${total} 条)\n\n`;
    const buttons = [];
    
    items.forEach((item, index) => {
      const num = page * pageSize + index + 1;
      const tags = item.tags.map(t => `#${t}`).join(' ');
      const content = item.content.length > 50 ? item.content.substring(0, 50) + '...' : item.content;
      const cleanContent = content.replace(/\n/g, ' ').replace(/```[\s\S]*?```/g, '[代码]');
      const sourceIcon = item.source === 'telegram_channel' ? '📢' : '👤';
      text += `<b>${num}.</b> ${sourceIcon} ${tags}\n${escapeHtml(cleanContent)}\n\n`;
      
      buttons.push([
        { text: `📄 ${num}`, callback_data: `view_${item.id}` },
        { text: `✏️`, callback_data: `edit_${item.id}` },
        { text: `🗑️`, callback_data: `delask_${item.id}` }
      ]);
    });
    
    const navButtons = [];
    if (page > 0) navButtons.push({ text: '⬅️ 上一页', callback_data: `act_all_${page - 1}` });
    navButtons.push({ text: `${page + 1}/${totalPages}`, callback_data: 'act_noop' });
    if (page < totalPages - 1) navButtons.push({ text: '➡️ 下一页', callback_data: `act_all_${page + 1}` });
    
    if (navButtons.length > 0) buttons.push(navButtons);
    buttons.push([{ text: '🏠 主菜单', callback_data: 'act_menu' }]);
    
    return editMessageText(botConfig.bot_token, chatId, messageId, text, { reply_markup: { inline_keyboard: buttons } });
  }
  
  if (data === 'act_noop') {
    return { ok: true };
  }
  
  if (data === 'act_tags') {
    const metadata = await getMetadata(env);
    const tags = metadata.tag_list || [];
    
    if (tags.length === 0) {
      return editMessageText(botConfig.bot_token, chatId, messageId, '🏷️ 暂无标签', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 主菜单', callback_data: 'act_menu' }]] }
      });
    }
    
    let text = '🏷️ <b>所有标签</b>\n\n';
    const buttons = [];
    
    for (const tag of tags) {
      const tagIds = await getTagIds(env, tag);
      text += `• <code>#${tag}</code> - ${tagIds.length} 条\n`;
    }
    
    let row = [];
    for (const tag of tags) {
      row.push({ text: `#${tag}`, callback_data: `tag_${tag}_0` });
      if (row.length === 3) {
        buttons.push(row);
        row = [];
      }
    }
    if (row.length > 0) buttons.push(row);
    buttons.push([{ text: '🏠 主菜单', callback_data: 'act_menu' }]);
    
    return editMessageText(botConfig.bot_token, chatId, messageId, text, { reply_markup: { inline_keyboard: buttons } });
  }
  
  if (data.startsWith('tag_')) {
    const parts = data.split('_');
    const page = parseInt(parts.pop()) || 0;
    const tag = parts.slice(1).join('_');
    const pageSize = 8;
    
    const tagIds = await getTagIds(env, tag);
    const collections = await getCollections(env);
    const items = collections.filter(c => tagIds.includes(c.id)).reverse();
    const total = items.length;
    const totalPages = Math.ceil(total / pageSize);
    const pageItems = items.slice(page * pageSize, (page + 1) * pageSize);
    
    let text = `🏷️ <b>#${escapeHtml(tag)}</b> (${total} 条)\n\n`;
    const buttons = [];
    
    pageItems.forEach((item, index) => {
      const num = page * pageSize + index + 1;
      const content = item.content.length > 50 ? item.content.substring(0, 50) + '...' : item.content;
      const cleanContent = content.replace(/\n/g, ' ').replace(/```[\s\S]*?```/g, '[代码]');
      const time = formatRelativeTime(item.timestamp);
      const sourceIcon = item.source === 'telegram_channel' ? '📢' : '👤';
      text += `<b>${num}.</b> ${sourceIcon} ${escapeHtml(cleanContent)}\n<i>${time}</i>\n\n`;
      
      buttons.push([
        { text: `📄 ${num}`, callback_data: `view_${item.id}` },
        { text: `✏️`, callback_data: `edit_${item.id}` },
        { text: `🗑️`, callback_data: `delask_${item.id}` }
      ]);
    });
    
    const navButtons = [];
    if (page > 0) navButtons.push({ text: '⬅️', callback_data: `tag_${tag}_${page - 1}` });
    if (totalPages > 1) navButtons.push({ text: `${page + 1}/${totalPages}`, callback_data: 'act_noop' });
    if (page < totalPages - 1) navButtons.push({ text: '➡️', callback_data: `tag_${tag}_${page + 1}` });
    
    if (navButtons.length > 0) buttons.push(navButtons);
    buttons.push([
      { text: '🏷️ 标签列表', callback_data: 'act_tags' },
      { text: '🏠 主菜单', callback_data: 'act_menu' }
    ]);
    
    return editMessageText(botConfig.bot_token, chatId, messageId, text, { reply_markup: { inline_keyboard: buttons } });
  }
  
  if (data.startsWith('view_')) {
    const id = data.replace('view_', '');
    const collections = await getCollections(env);
    const item = collections.find(c => c.id === id);
    
    if (!item) {
      return editMessageText(botConfig.bot_token, chatId, messageId, '❌ 项目不存在或已删除', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 主菜单', callback_data: 'act_menu' }]] }
      });
    }
    
    const tags = item.tags.map(t => `#${t}`).join(' ');
    const sourceInfo = item.source_info;
    let sourceText = item.source || 'web';
    if (sourceInfo) {
      if (sourceInfo.username) sourceText = `@${sourceInfo.username}`;
      else if (sourceInfo.channel_title) sourceText = `📢 ${sourceInfo.channel_title}`;
      else if (sourceInfo.first_name) sourceText = sourceInfo.first_name;
    }
    
    let contentDisplay = item.content;
    if (contentDisplay.length > 800) {
      contentDisplay = contentDisplay.substring(0, 800) + '\n\n... (内容过长已截断)';
    }
    
    const text = `📄 <b>收藏详情</b>\n\n` +
      `🏷️ 标签: ${tags}\n` +
      `📥 来源: ${sourceText}\n` +
      `🕐 时间: ${formatTime(item.timestamp)}\n` +
      (item.edited ? `✏️ 已编辑\n` : '') +
      `\n📝 内容:\n<pre>${escapeHtml(contentDisplay)}</pre>`;
    
    return editMessageText(botConfig.bot_token, chatId, messageId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ 编辑', callback_data: `edit_${id}` },
            { text: '🗑️ 删除', callback_data: `delask_${id}` }
          ],
          [
            { text: '🕐 最近', callback_data: 'act_recent' },
            { text: '🏠 主菜单', callback_data: 'act_menu' }
          ]
        ]
      }
    });
  }
  
  if (data.startsWith('delask_')) {
    const id = data.replace('delask_', '');
    const collections = await getCollections(env);
    const item = collections.find(c => c.id === id);
    
    let itemInfo = '';
    if (item) {
      const preview = item.content.substring(0, 50).replace(/\n/g, ' ');
      itemInfo = `\n\n预览: ${escapeHtml(preview)}...`;
    }
    
    return editMessageText(botConfig.bot_token, chatId, messageId, `⚠️ <b>确认删除此收藏？</b>${itemInfo}`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ 确认删除', callback_data: `delyes_${id}` },
            { text: '❌ 取消', callback_data: 'act_recent' }
          ]
        ]
      }
    });
  }
  
  if (data.startsWith('delyes_')) {
    const id = data.replace('delyes_', '');
    const success = await deleteItem(env, id);
    
    if (success) {
      return editMessageText(botConfig.bot_token, chatId, messageId, '✅ <b>删除成功！</b>', {
        reply_markup: {
          inline_keyboard: [[
            { text: '🕐 最近', callback_data: 'act_recent' },
            { text: '🏠 主菜单', callback_data: 'act_menu' }
          ]]
        }
      });
    } else {
      return editMessageText(botConfig.bot_token, chatId, messageId, '❌ 删除失败，项目可能已被删除', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 主菜单', callback_data: 'act_menu' }]] }
      });
    }
  }
  
  if (data.startsWith('edit_')) {
    const id = data.replace('edit_', '');
    const collections = await getCollections(env);
    const item = collections.find(c => c.id === id);
    
    if (!item) {
      return editMessageText(botConfig.bot_token, chatId, messageId, '❌ 项目不存在', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 主菜单', callback_data: 'act_menu' }]] }
      });
    }
    
    await env.NAV_KV.put(`state_${userId}`, JSON.stringify({ action: 'waiting_edit', itemId: id }), { expirationTtl: 300 });
    
    const currentTags = item.tags.map(t => `#${t}`).join(' ');
    const preview = item.content.length > 200 ? item.content.substring(0, 200) + '...' : item.content;
    
    return editMessageText(botConfig.bot_token, chatId, messageId,
      `✏️ <b>编辑收藏</b>\n\n当前标签: ${currentTags}\n当前内容:\n<pre>${escapeHtml(preview)}</pre>\n\n请发送新内容（包含 #标签）`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: `view_${id}` }]] } }
    );
  }
  
  return { ok: true };
}

async function handleAddContent(env, chatId, message, botConfig) {
  let content = message.text || message.caption || '';
  let sourceInfo = null;
  
  if (message.forward_from) {
    sourceInfo = {
      username: message.forward_from.username || null,
      first_name: message.forward_from.first_name || 'Unknown',
      user_id: message.forward_from.id.toString()
    };
  } else if (message.forward_from_chat) {
    sourceInfo = {
      username: message.forward_from_chat.username || null,
      first_name: message.forward_from_chat.title || 'Unknown',
      user_id: message.forward_from_chat.id.toString()
    };
  } else if (message.forward_sender_name) {
    sourceInfo = {
      username: null,
      first_name: message.forward_sender_name,
      user_id: 'hidden'
    };
  }
  
  // 使用 restoreEntities 转换 Telegram entities 为标准 Markdown
  const entities = message.entities || message.caption_entities || [];
  if (entities.length > 0) {
    content = restoreEntities(content, entities, 'std');
  }
  
  if (!content.trim()) {
    return sendMessage(botConfig.bot_token, chatId, '❌ 内容不能为空');
  }
  
  const tags = parseTags(content);
  const finalTags = tags.length > 0 ? tags : ['inbox'];
  
  // 保存 Telegram 消息信息
  const telegramMsgInfo = {
    chat_id: chatId,
    message_id: message.message_id,
    chat_type: 'private'
  };
  
  const item = await addItem(env, finalTags, content, sourceInfo ? 'telegram_forward' : 'telegram', sourceInfo, telegramMsgInfo);
  
  const tagsText = finalTags.map(t => `#${t}`).join(' ');
  let sourceText = '';
  if (sourceInfo) {
    if (sourceInfo.username) sourceText = `\n📥 转发自: @${sourceInfo.username}`;
    else if (sourceInfo.first_name) sourceText = `\n📥 转发自: ${sourceInfo.first_name}`;
  }
  
  const previewContent = content.substring(0, 80).replace(/\n/g, ' ').replace(/```[\s\S]*?```/g, '[代码块]');
  
  return sendMessage(botConfig.bot_token, chatId,
    `✅ <b>已添加！</b>\n\n🏷️ ${tagsText}${sourceText}\n📝 ${escapeHtml(previewContent)}${content.length > 80 ? '...' : ''}\n\n<i>💡 提示：编辑原消息可自动同步更新</i>`,
    {
      reply_to_message_id: message.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📄 查看', callback_data: `view_${item.id}` },
            { text: '✏️ 编辑', callback_data: `edit_${item.id}` }
          ],
          [
            { text: '➕ 继续添加', callback_data: 'act_add' },
            { text: '🏠 主菜单', callback_data: 'act_menu' }
          ]
        ]
      }
    }
  );
}

async function handleEditContent(env, chatId, message, itemId, botConfig) {
  const content = message.text || '';
  
  if (!content.trim()) {
    return sendMessage(botConfig.bot_token, chatId, '❌ 内容不能为空');
  }
  
  const tags = parseTags(content);
  const finalTags = tags.length > 0 ? tags : ['inbox'];
  
  const item = await editItem(env, itemId, finalTags, content);
  
  if (item) {
    return sendMessage(botConfig.bot_token, chatId, '✅ <b>已更新！</b>', {
      reply_markup: {
        inline_keyboard: [[
          { text: '📄 查看', callback_data: `view_${itemId}` },
          { text: '🏠 主菜单', callback_data: 'act_menu' }
        ]]
      }
    });
  } else {
    return sendMessage(botConfig.bot_token, chatId, '❌ 更新失败，项目可能已被删除');
  }
}

// ============== 路由处理 ==============

async function handleTelegramWebhook(request, env) {
  const botConfig = await getBotConfig(env);
  
  if (!botConfig.bot_token || !botConfig.webhook_secret) {
    return new Response('Bot not configured', { status: 500 });
  }
  
  const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secretToken !== botConfig.webhook_secret) {
    return new Response('Forbidden', { status: 403 });
  }
  
  try {
    const update = await request.json();
    console.log('Webhook update:', JSON.stringify(update));
    await handleTelegramUpdate(env, update, botConfig);
    return new Response('OK');
  } catch (e) {
    console.error('Webhook error:', e.message, e.stack);
    return new Response('Error', { status: 500 });
  }
}

async function handleAdminLogin(request, env) {
  const formData = await request.formData();
  const password = formData.get('password');
  
  if (password === env.ADMIN_PASSWORD) {
    const token = generateToken(env);
    return jsonResponse({ success: true }, 200, {
      'Set-Cookie': `admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
    });
  }
  
  return errorResponse('密码错误', 401);
}

async function handleApiData(request, env, url) {
  const tag = url.searchParams.get('tag');
  const source = url.searchParams.get('source');
  const q = url.searchParams.get('q');
  
  const metadata = await getMetadata(env);
  const siteConfig = await getSiteConfig(env);
  const collections = await getCollections(env);
  
  let filteredItems = [...collections].reverse();
  
  if (tag) {
    const tagIds = await getTagIds(env, tag);
    filteredItems = filteredItems.filter(item => tagIds.includes(item.id));
  }
  
  if (source) {
    filteredItems = filteredItems.filter(item => {
      if (!item.source_info) return false;
      return item.source_info.username === source || 
             item.source_info.user_id === source ||
             item.source_info.channel_id === source;
    });
  }
  
  if (q) {
    const keyword = q.toLowerCase();
    filteredItems = filteredItems.filter(item => 
      item.content.toLowerCase().includes(keyword) ||
      item.tags.some(t => t.includes(keyword))
    );
  }
  
  return jsonResponse({
    version: metadata.version,
    items: filteredItems,
    metadata: {
      total_count: metadata.total_count,
      tag_list: metadata.tag_list,
      last_updated: metadata.last_updated
    },
    siteConfig
  });
}

async function handleApiAdd(request, env) {
  if (!verifyToken(request, env)) {
    return errorResponse('Unauthorized', 401);
  }
  
  try {
    const data = await request.json();
    const tags = (data.tags || 'inbox').split(',').map(t => t.trim().toLowerCase()).filter(t => t);
    const content = data.content || '';
    
    if (!content.trim()) {
      return errorResponse('Content required');
    }
    
    const item = await addItem(env, tags, content, 'web');
    
    return successResponse({ item });
  } catch (e) {
    return errorResponse(e.message, 500);
  }
}

async function handleApiEdit(request, env, id) {
  if (!verifyToken(request, env)) {
    return errorResponse('Unauthorized', 401);
  }
  
  try {
    const data = await request.json();
    const tags = (data.tags || 'inbox').split(',').map(t => t.trim().toLowerCase()).filter(t => t);
    const content = data.content || '';
    
    const item = await editItem(env, id, tags, content);
    
    if (item) {
      return successResponse({ item });
    } else {
      return errorResponse('Item not found', 404);
    }
  } catch (e) {
    return errorResponse(e.message, 500);
  }
}

async function handleApiDelete(request, env, id) {
  if (!verifyToken(request, env)) {
    return errorResponse('Unauthorized', 401);
  }
  
  if (!id || id === 'null' || id === 'undefined') {
    return errorResponse('Invalid ID');
  }
  
  try {
    const success = await deleteItem(env, id);
    
    if (success) {
      return successResponse();
    } else {
      return errorResponse('Item not found', 404);
    }
  } catch (e) {
    return errorResponse(e.message, 500);
  }
}

async function handleApiSiteConfig(request, env) {
  if (!verifyToken(request, env)) {
    return errorResponse('Unauthorized', 401);
  }
  
  if (request.method === 'GET') {
    const config = await getSiteConfig(env);
    return jsonResponse(config);
  }
  
  if (request.method === 'POST') {
    try {
      const data = await request.json();
      const currentConfig = await getSiteConfig(env);
      
      if (data.footer_links) {
        const processedLinks = await Promise.all(data.footer_links.map(async (link) => {
          let favicon = link.favicon || '';
          if (!link.icon && link.url) {
            favicon = await fetchFavicon(link.url, link.favicon_service || null);
          }
          return { 
            icon: link.icon || '',
            text: link.text || '',
            url: link.url || '',
            favicon_service: link.favicon_service || '',
            favicon
          };
        }));
        data.footer_links = processedLinks;
      }
      
      const newConfig = { ...currentConfig, ...data };
      await saveSiteConfig(env, newConfig);
      return successResponse({ config: newConfig });
    } catch (e) {
      return errorResponse(e.message, 500);
    }
  }
  
  return new Response('Method not allowed', { status: 405 });
}

async function handleApiBotConfig(request, env) {
  if (!verifyToken(request, env)) {
    return errorResponse('Unauthorized', 401);
  }
  
  if (request.method === 'GET') {
    const config = await getBotConfig(env);
    return jsonResponse({
      ...config,
      bot_token: config.bot_token ? '***已配置***' : '',
      webhook_secret: config.webhook_secret ? '***已配置***' : ''
    });
  }
  
  if (request.method === 'POST') {
    try {
      const data = await request.json();
      const currentConfig = await getBotConfig(env);
      
      if (data.bot_token && data.bot_token !== '***已配置***') {
        currentConfig.bot_token = data.bot_token;
      }
      if (data.allowed_users !== undefined) {
        currentConfig.allowed_users = data.allowed_users;
      }
      if (data.allowed_channels !== undefined) {
        currentConfig.allowed_channels = data.allowed_channels;
      }
      
      await saveBotConfig(env, currentConfig);
      
      return successResponse({ 
        config: {
          ...currentConfig,
          bot_token: currentConfig.bot_token ? '***已配置***' : '',
          webhook_secret: currentConfig.webhook_secret ? '***已配置***' : ''
        }
      });
    } catch (e) {
      return errorResponse(e.message, 500);
    }
  }
  
  return new Response('Method not allowed', { status: 405 });
}

async function handleApiSetWebhook(request, env) {
  if (!verifyToken(request, env)) {
    return errorResponse('Unauthorized', 401);
  }
  
  try {
    const url = new URL(request.url);
    const botConfig = await getBotConfig(env);
    
    if (!botConfig.bot_token) {
      return errorResponse('Bot Token 未配置');
    }
    
    const webhookSecret = generateWebhookSecret();
    const webhookUrl = `${url.origin}/telegram-webhook`;
    
    const webhookResult = await callTelegramApi(botConfig.bot_token, 'setWebhook', {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: [
        'message', 
        'callback_query', 
        'edited_message',
        'channel_post',
        'edited_channel_post'
      ]
    });
    
    if (!webhookResult.ok) {
      return errorResponse('Webhook 设置失败: ' + (webhookResult.description || '未知错误'));
    }
    
    await callTelegramApi(botConfig.bot_token, 'setMyCommands', {
      commands: [
        { command: 'start', description: '启动 / 主菜单' },
        { command: 'menu', description: '打开主菜单' },
        { command: 'help', description: '使用帮助' }
      ]
    });
    
    botConfig.webhook_secret = webhookSecret;
    botConfig.webhook_url = webhookUrl;
    botConfig.webhook_set = true;
    await saveBotConfig(env, botConfig);
    
    return successResponse({ 
      message: 'Webhook 设置成功！已启用私聊和频道消息同步功能。',
      webhook_url: webhookUrl
    });
  } catch (e) {
    return errorResponse(e.message, 500);
  }
}

async function handleApiTags(env) {
  const metadata = await getMetadata(env);
  const tagCounts = {};
  for (const tag of (metadata.tag_list || [])) {
    const ids = await getTagIds(env, tag);
    tagCounts[tag] = ids.length;
  }
  return jsonResponse({ tags: tagCounts });
}

// 测试 Favicon 服务
async function handleApiTestFavicon(request) {
  try {
    const { url } = await request.json();
    if (!url) {
      return errorResponse('URL 不能为空');
    }
    
    const results = await testAllFaviconServices(url);
    return jsonResponse(results);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
}

// 获取 Favicon 服务列表
async function handleApiGetFaviconServices() {
  const services = Object.entries(FAVICON_SERVICES).map(([key, service]) => ({
    key,
    name: service.name,
    description: service.description
  }));
  return jsonResponse({ services });
}

async function handleCheckAuth(request, env) {
  const isAuth = verifyToken(request, env);
  return jsonResponse({ authenticated: isAuth });
}

// ============== SPA HTML 生成 ==============

function renderLogoHtml(siteConfig) {
  if (siteConfig.logo_type === 'url' && siteConfig.logo) {
    return `<img src="${escapeHtml(siteConfig.logo)}" alt="Logo" class="logo-img">`;
  } else if (siteConfig.logo_type === 'base64' && siteConfig.logo) {
    return `<img src="${siteConfig.logo}" alt="Logo" class="logo-img">`;
  }
  return `<span class="logo-emoji">${siteConfig.logo_emoji || '📚'}</span>`;
}

function getFaviconHref(siteConfig) {
  if (siteConfig.logo_type === 'url' && siteConfig.logo) {
    return escapeHtml(siteConfig.logo);
  } else if (siteConfig.logo_type === 'base64' && siteConfig.logo) {
    return siteConfig.logo;
  }
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${siteConfig.logo_emoji || '📚'}</text></svg>`;
}

async function renderSPA(env) {
  const siteConfig = await getSiteConfig(env);
  const metadata = await getMetadata(env);
  const collections = await getCollections(env);
  const botConfig = await getBotConfig(env);
  
  const initialData = {
    items: [...collections].reverse(),
    metadata,
    siteConfig,
    botConfigured: !!botConfig.bot_token && botConfig.webhook_set
  };

  const logoHtml = renderLogoHtml(siteConfig);
  const faviconHref = getFaviconHref(siteConfig);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(siteConfig.title)} - ${escapeHtml(siteConfig.description)}</title>
  <meta name="description" content="${escapeHtml(siteConfig.description)}">
  <meta name="keywords" content="导航,收藏,书签,链接管理">
  <meta property="og:title" content="${escapeHtml(siteConfig.title)}">
  <meta property="og:description" content="${escapeHtml(siteConfig.description)}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="${faviconHref}">
  <!-- 引入 marked.js 和 highlight.js -->
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/github-dark.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --primary: #6366f1;
      --primary-dark: #4f46e5;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --bg: #f8fafc;
      --bg-card: #ffffff;
      --bg-code: #1e293b;
      --text: #1e293b;
      --text-secondary: #64748b;
      --border: #e2e8f0;
      --shadow: 0 1px 3px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 40px rgba(0,0,0,0.1);
    }
    .dark {
      --bg: #0f172a;
      --bg-card: #1e293b;
      --bg-code: #0f172a;
      --text: #f1f5f9;
      --text-secondary: #94a3b8;
      --border: #334155;
      --shadow: 0 1px 3px rgba(0,0,0,0.3);
      --shadow-lg: 0 10px 40px rgba(0,0,0,0.4);
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      transition: background 0.3s, color 0.3s;
    }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
    
    .header {
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: var(--shadow);
    }
    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      gap: 16px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 18px;
      font-weight: 700;
      color: var(--text);
      text-decoration: none;
      cursor: pointer;
      flex-shrink: 0;
    }
    .logo:hover { text-decoration: none; }
    .logo-img { height: 32px; width: 32px; object-fit: cover; border-radius: 8px; }
    .logo-emoji { font-size: 28px; line-height: 1; }
    .logo span { white-space: nowrap; }
    .header-actions { display: flex; align-items: center; gap: 8px; }
    
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
    }
    .btn-icon {
      width: 38px;
      height: 38px;
      padding: 0;
      border-radius: 10px;
      background: var(--bg);
      color: var(--text-secondary);
      border: 1px solid var(--border);
    }
    .btn-icon:hover { background: var(--border); color: var(--text); }
    .btn-icon svg { width: 20px; height: 20px; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-dark); text-decoration: none; }
    .btn-secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); text-decoration: none; }
    .btn-success { background: var(--success); color: white; }
    .btn-success:hover { opacity: 0.9; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-danger:hover { opacity: 0.9; }
    
    .nav-tabs {
      display: flex;
      gap: 4px;
      background: var(--bg);
      padding: 4px;
      border-radius: 10px;
    }
    .nav-tab {
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
    }
    .nav-tab:hover { color: var(--text); }
    .nav-tab.active { background: var(--bg-card); color: var(--primary); box-shadow: var(--shadow); }
    
    .search-section { padding: 20px 0; }
    .search-box { display: flex; gap: 12px; max-width: 600px; }
    .search-input {
      flex: 1;
      padding: 12px 16px;
      border: 2px solid var(--border);
      border-radius: 10px;
      font-size: 15px;
      background: var(--bg-card);
      color: var(--text);
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input:focus { border-color: var(--primary); }
    .search-input::placeholder { color: var(--text-secondary); }
    
    .stats-bar { display: flex; align-items: center; gap: 24px; padding: 20px 0; flex-wrap: wrap; }
    .stat-item { display: flex; align-items: center; gap: 8px; }
    .stat-value { font-size: 24px; font-weight: 700; color: var(--primary); }
    .stat-label { font-size: 13px; color: var(--text-secondary); }
    
    .tags-section { padding: 16px 0; border-top: 1px solid var(--border); }
    .tags-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .tag-chip {
      padding: 6px 14px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }
    .tag-chip:hover { border-color: var(--primary); color: var(--primary); }
    .tag-chip.active { background: var(--primary); border-color: var(--primary); color: white; }
    
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 16px;
    }
    .filter-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: var(--primary);
      color: white;
      border-radius: 20px;
      font-size: 13px;
    }
    .filter-badge button {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 0 0 0 4px;
      font-size: 16px;
      line-height: 1;
    }
    
    .items-grid { display: flex; flex-direction: column; gap: 16px; padding-bottom: 40px; }
    
    .item-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      box-shadow: var(--shadow);
      transition: all 0.3s;
      animation: fadeIn 0.3s ease;
    }
    .item-card:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
    .item-card.removing { animation: fadeOut 0.3s ease forwards; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeOut { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-10px); } }
    
    .item-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .item-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .item-tag {
      padding: 4px 10px;
      background: linear-gradient(135deg, #eef2ff, #e0e7ff);
      color: var(--primary);
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .dark .item-tag { background: rgba(99,102,241,0.2); }
    .item-tag:hover { background: var(--primary); color: white; }
    .item-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s; }
    .item-card:hover .item-actions { opacity: 1; }
    .item-action {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      border: none;
      background: var(--bg);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
      font-size: 14px;
    }
    .item-action:hover { background: var(--border); color: var(--text); }
    .item-action.danger:hover { background: #fee2e2; color: var(--danger); }
    
    /* 内容中的内联标签样式 */
    .inline-tag {
      display: inline-block;
      padding: 2px 8px;
      background: linear-gradient(135deg, #eef2ff, #e0e7ff);
      color: var(--primary);
      border-radius: 10px;
      font-size: 0.9em;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      margin: 0 2px;
    }
    .dark .inline-tag { background: rgba(99,102,241,0.2); }
    .inline-tag:hover { background: var(--primary); color: white; }
    
    /* Markdown 内容样式 */
    .item-content {
      color: var(--text);
      line-height: 1.8;
      word-break: break-word;
    }
    .item-content h1, .item-content h2, .item-content h3, 
    .item-content h4, .item-content h5, .item-content h6 {
      margin: 16px 0 8px 0;
      font-weight: 600;
      line-height: 1.4;
    }
    .item-content h1 { font-size: 1.5em; border-bottom: 2px solid var(--border); padding-bottom: 8px; }
    .item-content h2 { font-size: 1.3em; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .item-content h3 { font-size: 1.15em; }
    .item-content h4 { font-size: 1.05em; }
    .item-content h5 { font-size: 1em; }
    .item-content h6 { font-size: 0.95em; color: var(--text-secondary); }
    .item-content p { margin: 8px 0; }
    .item-content strong { font-weight: 600; }
    .item-content em { font-style: italic; }
    .item-content del { text-decoration: line-through; color: var(--text-secondary); }
    .item-content blockquote {
      margin: 12px 0;
      padding: 12px 16px;
      border-left: 4px solid var(--primary);
      background: var(--bg);
      border-radius: 0 8px 8px 0;
      color: var(--text-secondary);
    }
    .item-content blockquote p { margin: 0; }
    .item-content ul, .item-content ol {
      margin: 12px 0;
      padding-left: 24px;
    }
    .item-content li { margin: 4px 0; }
    .item-content hr {
      margin: 16px 0;
      border: none;
      border-top: 2px solid var(--border);
    }
    .item-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 14px;
    }
    .item-content th, .item-content td {
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
    }
    .item-content th {
      background: var(--bg);
      font-weight: 600;
    }
    .item-content img {
      max-width: 100%;
      border-radius: 8px;
      margin: 8px 0;
    }
    
    /* 代码块样式 */
    .item-content pre {
      background: var(--bg-code);
      border: 2px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      overflow-x: auto;
      margin: 16px 0;
      position: relative;
    }
    .item-content pre code {
      background: transparent;
      padding: 0;
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      font-size: 13px;
      line-height: 1.6;
      color: #e2e8f0;
    }
    .dark .item-content pre code {
      color: #e2e8f0;
    }
    .item-content code:not(pre code) {
      background: var(--bg);
      color: var(--danger);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.9em;
    }
    
    .code-block-wrapper {
      margin: 16px 0;
      border-radius: 12px;
      overflow: hidden;
      background: var(--bg-code);
      border: 2px solid var(--border);
    }
    .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: rgba(0,0,0,0.3);
      border-bottom: 1px solid var(--border);
    }
    .code-lang {
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .copy-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(255,255,255,0.1);
      border: none;
      border-radius: 6px;
      color: #94a3b8;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .copy-btn:hover { background: rgba(255,255,255,0.2); color: white; }
    
    .item-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-secondary);
      flex-wrap: wrap;
    }
    .source-link { color: var(--success); cursor: pointer; background: none; border: none; font-size: inherit; }
    .source-link:hover { text-decoration: underline; }
    .edited-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: rgba(245,158,11,0.1);
      color: var(--warning);
      border-radius: 10px;
      font-size: 11px;
    }
    
    .empty-state { text-align: center; padding: 80px 20px; color: var(--text-secondary); }
    .empty-icon { font-size: 64px; margin-bottom: 16px; }
    
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: var(--bg-code);
      color: white;
      padding: 12px 24px;
      border-radius: 10px;
      box-shadow: var(--shadow-lg);
      z-index: 9999;
      transition: transform 0.3s ease;
      font-size: 14px;
    }
    .toast.show { transform: translateX(-50%) translateY(0); }
    
    .modal {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }
    .modal.show { display: flex; }
    .modal-content {
      background: var(--bg-card);
      border-radius: 20px;
      width: 100%;
      max-width: 500px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: var(--shadow-lg);
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
    }
    .modal-title { font-size: 18px; font-weight: 600; }
    .modal-close {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      border: none;
      background: var(--bg);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 18px;
    }
    .modal-close:hover { background: var(--border); }
    .modal-body { padding: 24px; }
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 24px;
      border-top: 1px solid var(--border);
    }
    
    .form-group { margin-bottom: 20px; }
    .form-label { display: block; margin-bottom: 8px; font-weight: 500; font-size: 14px; }
    .form-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
    .form-input, .form-select {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid var(--border);
      border-radius: 10px;
      font-size: 15px;
      background: var(--bg);
      color: var(--text);
      outline: none;
      transition: border-color 0.2s;
    }
    .form-input:focus, .form-select:focus { border-color: var(--primary); }
    .form-textarea { min-height: 150px; resize: vertical; font-family: inherit; }
    .form-row { display: flex; gap: 12px; align-items: flex-end; }
    .form-row .form-group { flex: 1; margin-bottom: 0; }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-badge.success { background: rgba(16,185,129,0.1); color: var(--success); }
    .status-badge.warning { background: rgba(245,158,11,0.1); color: var(--warning); }
    
    .loading-overlay {
      position: fixed;
      inset: 0;
      background: rgba(255,255,255,0.8);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }
    .dark .loading-overlay { background: rgba(15,23,42,0.8); }
    .loading-overlay.show { display: flex; }
    .loading-spinner {
      width: 48px;
      height: 48px;
      border: 4px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    
    .tags-cloud {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: center;
      padding: 32px;
      background: var(--bg-card);
      border-radius: 16px;
      border: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .cloud-tag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      background: linear-gradient(135deg, var(--primary), #8b5cf6);
      color: white;
      border-radius: 25px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }
    .cloud-tag:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(99,102,241,0.4); }
    .cloud-tag .count {
      background: rgba(255,255,255,0.3);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
    }
    
    .config-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .config-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .login-page {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%);
      padding: 20px;
    }
    .login-card {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 24px;
      padding: 48px;
      width: 100%;
      max-width: 400px;
    }
    .login-title { text-align: center; color: white; margin-bottom: 8px; font-size: 28px; }
    .login-subtitle { text-align: center; color: rgba(255,255,255,0.7); margin-bottom: 32px; }
    .login-card .form-input {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.2);
      color: white;
    }
    .login-card .form-input::placeholder { color: rgba(255,255,255,0.5); }
    .login-card .form-input:focus { border-color: #818cf8; }
    .login-card .btn-primary {
      width: 100%;
      padding: 14px;
      font-size: 16px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
    }
    .login-error {
      background: rgba(239,68,68,0.2);
      border: 1px solid rgba(239,68,68,0.3);
      color: #fca5a5;
      padding: 12px;
      border-radius: 10px;
      margin-bottom: 20px;
      text-align: center;
    }
    
    .admin-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 0;
      flex-wrap: wrap;
    }
    .admin-toolbar .btn { white-space: nowrap; }
    
    .site-footer {
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      padding: 32px 0;
      margin-top: 48px;
    }
    .footer-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 16px 32px;
    }
    .footer-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text-secondary);
      font-size: 14px;
      text-decoration: none;
      padding: 8px 12px;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .footer-link:hover {
      color: var(--primary);
      background: var(--bg);
      text-decoration: none;
    }
    .footer-link-icon { font-size: 16px; }
    .footer-link-favicon {
      width: 16px;
      height: 16px;
      object-fit: contain;
      vertical-align: middle;
    }
    .footer-copyright {
      text-align: center;
      color: var(--text-secondary);
      font-size: 13px;
      margin-top: 16px;
    }
    
    .footer-cards {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 20px;
    }
    .footer-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .footer-card-fields {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .footer-card-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .footer-card-field label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
    }
    .footer-card-field input {
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 14px;
      background: var(--bg-card);
      color: var(--text);
    }
    .footer-card-field input:focus, .footer-card-field select:focus {
      outline: none;
      border-color: var(--primary);
    }
    .footer-card-row { display: flex; gap: 8px; align-items: center; }
    .footer-card-row input { flex: 1; min-width: 0; }
    .footer-card-row .btn { flex-shrink: 0; padding: 10px 12px; font-size: 13px; }
    .footer-card-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    
    @media (max-width: 768px) {
      .header-inner { flex-wrap: wrap; }
      .nav-tabs { order: 3; width: 100%; justify-content: center; margin-top: 8px; }
      .nav-tab { padding: 6px 12px; font-size: 13px; }
      .stats-bar { justify-content: center; }
      .item-actions { opacity: 1; }
      .admin-toolbar { justify-content: center; }
      .form-row { flex-direction: column; }
      .logo { font-size: 16px; }
      .logo-img { height: 28px; width: 28px; }
      .logo-emoji { font-size: 24px; }
      .footer-links { gap: 8px 16px; }
      .footer-link { padding: 6px 10px; font-size: 13px; }
    }
    @media (max-width: 480px) {
      .logo span { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="toast" class="toast"></div>
  <div id="loading" class="loading-overlay"><div class="loading-spinner"></div></div>

  <script id="init-data" type="application/json">${JSON.stringify(initialData)}</script>
  <script>
    // ========== State ==========
    var state = {
      page: 'home',
      isAdmin: false,
      theme: localStorage.getItem('theme') || 'light',
      currentTag: '',
      currentSource: '',
      currentQ: '',
      items: [],
      metadata: { total_count: 0, tag_list: [], last_updated: null },
      siteConfig: { title: 'NavCollect', description: '个人网站导航收藏系统', logo_emoji: '📚', footer_links: [] },
      botConfigured: false,
      version: 0,
      footerItems: []
    };
    
    var deleteId = null;
    var footerIdCounter = 0;
    
    // ========== Utilities ==========
    function $(sel) { return document.querySelector(sel); }
    function $$(sel) { return document.querySelectorAll(sel); }
    
    function showToast(msg) {
      var toast = $('#toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(function() { toast.classList.remove('show'); }, 2500);
    }
    
    function showLoading() { $('#loading').classList.add('show'); }
    function hideLoading() { $('#loading').classList.remove('show'); }
    
    function escapeHtml(text) {
      if (!text) return '';
      var div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function formatTime(ts) {
      if (!ts) return '';
      return ts.replace('T', ' ').split('+')[0];
    }
    
    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(function() {
        showToast('已复制到剪贴板');
      });
    }
    
    // 使用 marked.js 渲染 Markdown
    function formatContent(text) {
      if (!text) return '';
      
      // 配置 marked 选项
      marked.setOptions({
        gfm: true, // 启用 GitHub Flavored Markdown
        breaks: true, // 将换行符转换为 <br>
        headerIds: false, // 不生成 header id
        highlight: function(code, lang) {
          if (lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch (err) {
              console.error('Highlight error:', err);
            }
          }
          return hljs.highlightAuto(code).value;
        }
      });
      
      // 预处理：在 --- 前后添加空行，防止被解析为 Setext 标题
      text = text.replace(/([^\\n])\\n---\\n/g, '$1\\n\\n---\\n\\n');
      text = text.replace(/([^\\n])\\n===\\n/g, '$1\\n\\n===\\n\\n');
      
      // 第1步：保护代码块内容，防止其中的 #tag 被转换
      // 使用 null 字符作为占位符（不会被 Markdown 解析器处理）
      var codeBlocks = [];
      var codeBlockIndex = 0;
      text = text.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(match) {
        var placeholder = '\\x00CODEBLOCK' + codeBlockIndex + '\\x00';
        codeBlocks.push(match);
        codeBlockIndex++;
        return placeholder;
      });
      
      // 第2步：在 Markdown 源码中转换 #tag（代码块已被保护）
      text = text.replace(/#([\\w\\u4e00-\\u9fa5]+)/g, function(match, tag) {
        return '<span class="inline-tag" onclick="filterByTag(\\'' + tag.toLowerCase() + '\\')">' + match + '</span>';
      });
      
      // 第3步：恢复代码块
      text = text.replace(/\\x00CODEBLOCK(\\d+)\\x00/g, function(match, index) {
        return codeBlocks[parseInt(index)];
      });
      
      // 第4步：渲染 Markdown
      var html = marked.parse(text);
      
      // 第5步：为代码块添加复制按钮
      html = html.replace(/<pre><code class="([^"]*)">([\\s\\S]*?)<\\/code><\\/pre>/g, function(match, className, codeContent) {
        var lang = className.replace('language-', '') || 'text';
        var cleanCode = codeContent.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        var codeId = 'code-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        
        return '<div class="code-block-wrapper"><div class="code-block-header">' +
          '<span class="code-lang">' + escapeHtml(lang) + '</span>' +
          '<button class="copy-btn" onclick="copyToClipboard(document.getElementById(\\'' + codeId + '\\').textContent)">📋 复制</button>' +
          '</div><pre id="' + codeId + '"><code class="' + className + '">' + codeContent + '</code></pre></div>';
      });
      
      return html;
    }
    
    function setTheme(theme) {
      state.theme = theme;
      localStorage.setItem('theme', theme);
      document.documentElement.className = theme;
      render();
    }
    
    function toggleTheme() {
      setTheme(state.theme === 'dark' ? 'light' : 'dark');
    }
    
    // ========== Footer Items Sync ==========
    function syncFooterItems() {
      state.footerItems = (state.siteConfig.footer_links || []).map(function(link, i) {
        return { 
          id: i, 
          icon: link.icon || '', 
          text: link.text || '', 
          url: link.url || '', 
          favicon: link.favicon || '',
          favicon_service: link.favicon_service || ''
        };
      });
      footerIdCounter = state.footerItems.length;
    }
    
    // ========== Navigation ==========
    function navigate(page, pushState) {
      state.page = page;
      if (pushState !== false) {
        var url = page === 'home' ? '/' : '/' + page;
        history.pushState({ page: page }, '', url);
      }
      
      render();
      window.scrollTo(0, 0);
    }
    
    function filterByTag(tag) {
      state.currentTag = tag;
      state.currentSource = '';
      state.currentQ = '';
      history.pushState({}, '', tag ? '/?tag=' + encodeURIComponent(tag) : '/');
      render();
    }
    
    function filterBySource(source) {
      state.currentSource = source;
      state.currentTag = '';
      state.currentQ = '';
      history.pushState({}, '', '/?source=' + encodeURIComponent(source));
      render();
    }
    
    function searchItems(q) {
      state.currentQ = q;
      state.currentTag = '';
      state.currentSource = '';
      history.pushState({}, '', q ? '/?q=' + encodeURIComponent(q) : '/');
      render();
    }
    
    function clearFilters() {
      state.currentTag = '';
      state.currentSource = '';
      state.currentQ = '';
      history.pushState({}, '', '/');
      render();
    }
    
    // ========== API ==========
    function apiCall(method, url, data) {
      var options = { method: method, headers: { 'Content-Type': 'application/json' } };
      if (data) options.body = JSON.stringify(data);
      return fetch(url, options).then(function(res) { return res.json(); });
    }
    
    function loadData() {
      var params = new URLSearchParams();
      if (state.currentTag) params.set('tag', state.currentTag);
      if (state.currentSource) params.set('source', state.currentSource);
      if (state.currentQ) params.set('q', state.currentQ);
      
      return fetch('/api/data?' + params.toString())
        .then(function(res) { return res.json(); })
        .then(function(data) {
          state.version = data.version;
          state.items = data.items;
          state.metadata = data.metadata;
          if (data.siteConfig) {
            state.siteConfig = data.siteConfig;
            syncFooterItems();
          }
          return true;
        });
    }
    
    function checkAuth() {
      return fetch('/api/auth').then(function(res) { return res.json(); });
    }
    
    function login(password) {
      var formData = new FormData();
      formData.append('password', password);
      return fetch('/admin/login', { method: 'POST', body: formData }).then(function(res) { return res.json(); });
    }
    
    function getFilteredItems() {
      var items = state.items;
      if (state.currentTag) {
        items = items.filter(function(item) { return item.tags.indexOf(state.currentTag) !== -1; });
      }
      if (state.currentSource) {
        items = items.filter(function(item) {
          if (!item.source_info) return false;
          return item.source_info.username === state.currentSource || 
                 item.source_info.user_id === state.currentSource ||
                 item.source_info.channel_id === state.currentSource;
        });
      }
      if (state.currentQ) {
        var q = state.currentQ.toLowerCase();
        items = items.filter(function(item) {
          return item.content.toLowerCase().indexOf(q) !== -1 || item.tags.some(function(t) { return t.indexOf(q) !== -1; });
        });
      }
      return items;
    }
    
    // ========== Render Helpers ==========
    function renderLogo() {
      if (state.siteConfig.logo_type === 'url' && state.siteConfig.logo) {
        return '<img src="' + escapeHtml(state.siteConfig.logo) + '" alt="Logo" class="logo-img">';
      } else if (state.siteConfig.logo_type === 'base64' && state.siteConfig.logo) {
        return '<img src="' + state.siteConfig.logo + '" alt="Logo" class="logo-img">';
      }
      return '<span class="logo-emoji">' + (state.siteConfig.logo_emoji || '📚') + '</span>';
    }
    
    function renderThemeButton() {
      var icon = state.theme === 'dark' 
        ? '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>'
        : '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>';
      return '<button class="btn-icon" onclick="toggleTheme()" title="切换主题">' + icon + '</button>';
    }
    
    function renderHeader(showSSE) {
      return '<header class="header"><div class="container"><div class="header-inner">' +
        '<a class="logo" onclick="navigate(\\'home\\'); clearFilters();">' + renderLogo() + '<span>' + escapeHtml(state.siteConfig.title) + '</span></a>' +
        '<div class="nav-tabs">' +
          '<button class="nav-tab ' + (state.page === 'home' ? 'active' : '') + '" onclick="navigate(\\'home\\')">🏠 首页</button>' +
          '<button class="nav-tab ' + (state.page === 'tags' ? 'active' : '') + '" onclick="navigate(\\'tags\\')">🏷️ 标签</button>' +
          '<button class="nav-tab ' + (state.page === 'admin' || state.page === 'config' || state.page === 'footer' ? 'active' : '') + '" onclick="navigate(\\'admin\\')">⚙️ 管理</button>' +
        '</div>' +
        '<div class="header-actions">' + renderThemeButton() + '</div>' +
        '</div></div></header>';
    }
    
    function renderFooterLinkIcon(link) {
      if (link.icon && link.icon.trim()) {
        if (link.icon.startsWith('http://') || link.icon.startsWith('https://') || link.icon.startsWith('data:')) {
          return '<img src="' + escapeHtml(link.icon) + '" class="footer-link-favicon" alt="">';
        }
        return '<span class="footer-link-icon">' + escapeHtml(link.icon) + '</span>';
      }
      if (link.favicon) {
        return '<img src="' + link.favicon + '" class="footer-link-favicon" alt="" onerror="this.style.display=\\'none\\'">';
      }
      return '';
    }
    
    function renderFooterLink(link) {
      var iconHtml = renderFooterLinkIcon(link);
      if (link.url) {
        return '<a href="' + escapeHtml(link.url) + '" class="footer-link" target="_blank" rel="noopener">' + iconHtml + escapeHtml(link.text) + '</a>';
      }
      return '<span class="footer-link">' + iconHtml + escapeHtml(link.text) + '</span>';
    }
    
    function renderFooter() {
      var links = state.siteConfig.footer_links || [];
      if (links.length === 0) return '';
      
      var linksHtml = links.map(renderFooterLink).join('');
      
      return '<footer class="site-footer"><div class="container">' +
        '<div class="footer-links">' + linksHtml + '</div>' +
        '<div class="footer-copyright">© ' + new Date().getFullYear() + ' ' + escapeHtml(state.siteConfig.title) + '</div>' +
        '</div></footer>';
    }
    
    function renderStats() {
      var channelCount = state.items.filter(function(item) { return item.source === 'telegram_channel'; }).length;
      return '<div class="stats-bar">' +
        '<div class="stat-item"><span class="stat-value">' + (state.metadata.total_count || 0) + '</span><span class="stat-label">总收藏</span></div>' +
        '<div class="stat-item"><span class="stat-value">' + (state.metadata.tag_list || []).length + '</span><span class="stat-label">标签数</span></div>' +
        '<div class="stat-item"><span class="stat-value">' + channelCount + '</span><span class="stat-label">频道收藏</span></div>' +
        '</div>';
    }
    
    function renderTagsList(showAll) {
      var tags = state.metadata.tag_list || [];
      var displayTags = showAll ? tags : tags.slice(0, 15);
      
      var html = '';
      if (showAll) {
        html += '<button class="tag-chip ' + (!state.currentTag ? 'active' : '') + '" onclick="filterByTag(\\'\\')">全部</button>';
      }
      
      html += displayTags.map(function(tag) {
        return '<button class="tag-chip ' + (state.currentTag === tag ? 'active' : '') + '" onclick="filterByTag(\\'' + escapeHtml(tag) + '\\')">#' + escapeHtml(tag) + '</button>';
      }).join('');
      
      if (!showAll && tags.length > 15) {
        html += '<button class="tag-chip" onclick="navigate(\\'tags\\')">更多...</button>';
      }
      
      return '<div class="tags-section"><div class="tags-list">' + html + '</div></div>';
    }
    
    function renderFilterBar() {
      if (!state.currentTag && !state.currentSource && !state.currentQ) return '';
      
      var html = '<div class="filter-bar"><span>筛选：</span>';
      if (state.currentTag) html += '<span class="filter-badge">#' + escapeHtml(state.currentTag) + '<button onclick="clearFilters()">×</button></span>';
      if (state.currentSource) html += '<span class="filter-badge">@' + escapeHtml(state.currentSource) + '<button onclick="clearFilters()">×</button></span>';
      if (state.currentQ) html += '<span class="filter-badge">"' + escapeHtml(state.currentQ) + '"<button onclick="clearFilters()">×</button></span>';
      html += '</div>';
      return html;
    }
    
    function renderItemCard(item, isAdmin) {
      var tags = item.tags.map(function(t) {
        return '<button class="item-tag" onclick="filterByTag(\\'' + escapeHtml(t) + '\\')">#' + escapeHtml(t) + '</button>';
      }).join('');
      
      var sourceHtml = '';
      if (item.source_info) {
        var si = item.source_info;
        if (si.username) {
          sourceHtml = '<button class="source-link" onclick="filterBySource(\\'' + escapeHtml(si.username) + '\\')">@' + escapeHtml(si.username) + '</button>';
        } else if (si.channel_title) {
          sourceHtml = '<button class="source-link" onclick="filterBySource(\\'' + escapeHtml(si.channel_id) + '\\')">📢 ' + escapeHtml(si.channel_title) + '</button>';
        } else if (si.first_name) {
          sourceHtml = '<button class="source-link" onclick="filterBySource(\\'' + escapeHtml(si.user_id) + '\\')">' + escapeHtml(si.first_name) + '</button>';
        }
      } else {
        sourceHtml = '<span>' + escapeHtml(item.source || 'web') + '</span>';
      }
      
      var actions = isAdmin 
        ? '<div class="item-actions">' +
            '<button class="item-action" onclick="showEditModal(\\'' + item.id + '\\')" title="编辑">✏️</button>' +
            '<button class="item-action danger" onclick="showDeleteConfirm(\\'' + item.id + '\\')" title="删除">🗑️</button>' +
          '</div>'
        : '';
      
      var editedBadge = item.edited ? '<span class="edited-badge">✏️ 已编辑</span>' : '';
      
      return '<div class="item-card" id="item-' + item.id + '">' +
        '<div class="item-header"><div class="item-tags">' + tags + '</div>' + actions + '</div>' +
        '<div class="item-content">' + formatContent(item.content) + '</div>' +
        '<div class="item-meta"><span>📥 ' + sourceHtml + '</span><span>🕐 ' + formatTime(item.timestamp) + '</span>' + editedBadge + '</div>' +
        '</div>';
    }
    
    function renderItemsList(isAdmin) {
      var items = getFilteredItems();
      if (items.length === 0) {
        return '<div class="empty-state"><div class="empty-icon">📭</div><p>暂无收藏</p></div>';
      }
      return items.map(function(item) { return renderItemCard(item, isAdmin); }).join('');
    }
    
    function renderModals() {
      return '<div id="add-modal" class="modal"><div class="modal-content">' +
        '<div class="modal-header"><span class="modal-title" id="modal-title">添加收藏</span><button class="modal-close" onclick="hideAddModal()">×</button></div>' +
        '<div class="modal-body"><input type="hidden" id="edit-id">' +
        '<div class="form-group"><label class="form-label">标签（逗号分隔）</label><input type="text" class="form-input" id="input-tags" placeholder="tech, ai, tools"></div>' +
        '<div class="form-group"><label class="form-label">内容</label><textarea class="form-input form-textarea" id="input-content" placeholder="支持 Markdown 语法"></textarea></div>' +
        '</div>' +
        '<div class="modal-footer"><button class="btn btn-secondary" onclick="hideAddModal()">取消</button><button class="btn btn-primary" onclick="saveItem()">保存</button></div>' +
        '</div></div>' +
        '<div id="confirm-modal" class="modal"><div class="modal-content" style="max-width:400px"><div class="modal-body" style="text-align:center;padding:40px">' +
        '<div style="font-size:48px;margin-bottom:16px">⚠️</div>' +
        '<div style="font-size:20px;font-weight:600;margin-bottom:8px">确认删除？</div>' +
        '<div style="color:var(--text-secondary);margin-bottom:24px">此操作不可恢复</div>' +
        '<div style="display:flex;gap:12px;justify-content:center">' +
          '<button class="btn btn-secondary" onclick="hideConfirmModal()">取消</button>' +
          '<button class="btn btn-danger" onclick="confirmDelete()">删除</button>' +
        '</div></div></div></div>';
    }
    
    // ========== Render Pages ==========
    function render() {
      document.documentElement.className = state.theme;
      var app = $('#app');
      
      if (state.page === 'login') {
        app.innerHTML = renderLoginPage();
      } else if (state.page === 'admin') {
        app.innerHTML = state.isAdmin ? renderAdminPage() : renderLoginPage();
      } else if (state.page === 'tags') {
        app.innerHTML = renderTagsPage();
      } else if (state.page === 'config') {
        app.innerHTML = state.isAdmin ? renderConfigPage() : renderLoginPage();
      } else if (state.page === 'footer') {
        app.innerHTML = state.isAdmin ? renderFooterConfigPage() : renderLoginPage();
      } else {
        app.innerHTML = renderHomePage();
      }
      
      bindEvents();
    }
    
    function renderHomePage() {
      return renderHeader(false) +
        '<div class="container">' +
          '<section class="search-section"><div class="search-box">' +
            '<input type="text" class="search-input" id="search-input" placeholder="搜索关键词..." value="' + escapeHtml(state.currentQ) + '">' +
            '<button class="btn btn-primary" onclick="doSearch()">搜索</button>' +
          '</div></section>' +
          renderStats() +
          renderTagsList(false) +
          renderFilterBar() +
          '<div class="items-grid">' + renderItemsList(false) + '</div>' +
        '</div>' +
        renderFooter();
    }
    
    function renderTagsPage() {
      var tagCounts = {};
      state.items.forEach(function(item) {
        item.tags.forEach(function(tag) { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
      });
      
      var sortedTags = Object.entries(tagCounts).sort(function(a, b) { return b[1] - a[1]; });
      var maxCount = Math.max.apply(null, Object.values(tagCounts).concat([1]));
      
      var cloudHtml = sortedTags.map(function(entry) {
        var tag = entry[0], count = entry[1];
        var size = Math.max(0.9, Math.min(1.4, 0.9 + (count / maxCount) * 0.5));
        return '<button class="cloud-tag" style="font-size:' + size + 'rem" onclick="filterByTag(\\'' + escapeHtml(tag) + '\\'); navigate(\\'home\\');">#' + escapeHtml(tag) + '<span class="count">' + count + '</span></button>';
      }).join('');
      
      return renderHeader(false) +
        '<div class="container" style="padding-top:32px;padding-bottom:40px;">' +
          '<h1 style="text-align:center;margin-bottom:32px;">🏷️ 标签云</h1>' +
          '<div class="tags-cloud">' + (cloudHtml || '<p style="color:var(--text-secondary)">暂无标签</p>') + '</div>' +
        '</div>' +
        renderFooter();
    }
    
    function renderAdminPage() {
      return renderHeader(true) +
        '<div class="container">' +
          renderStats() +
          '<div class="admin-toolbar">' +
            '<button class="btn btn-primary" onclick="showAddModal()">➕ 添加收藏</button>' +
            '<button class="btn btn-secondary" onclick="navigate(\\'config\\')">⚙️ 系统设置</button>' +
            '<button class="btn btn-secondary" onclick="navigate(\\'footer\\')">🔗 页脚配置</button>' +
            '<button class="btn btn-secondary" onclick="refreshData()">🔄 刷新数据</button>' +
            '<a href="/admin/logout" class="btn btn-secondary">🚪 退出登录</a>' +
          '</div>' +
          renderTagsList(true) +
          '<div class="items-grid">' + renderItemsList(true) + '</div>' +
        '</div>' +
        renderModals();
    }
    
    function renderConfigPage() {
      return renderHeader(false) +
        '<div class="container" style="padding-top:24px;padding-bottom:40px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">' +
            '<h1>⚙️ 系统设置</h1>' +
            '<button class="btn btn-secondary" onclick="navigate(\\'admin\\')">← 返回管理</button>' +
          '</div>' +
          
          '<div class="config-section">' +
            '<div class="config-title">🌐 网站配置</div>' +
            '<div class="form-group"><label class="form-label">网站标题</label><input type="text" class="form-input" id="cfg-title" value="' + escapeHtml(state.siteConfig.title) + '"></div>' +
            '<div class="form-group"><label class="form-label">网站描述</label><input type="text" class="form-input" id="cfg-description" value="' + escapeHtml(state.siteConfig.description) + '"></div>' +
            '<div class="form-group"><label class="form-label">Logo 类型</label>' +
              '<select class="form-select" id="cfg-logo-type" onchange="toggleLogoFields()">' +
                '<option value="emoji"' + (state.siteConfig.logo_type !== 'url' && state.siteConfig.logo_type !== 'base64' ? ' selected' : '') + '>Emoji</option>' +
                '<option value="url"' + (state.siteConfig.logo_type === 'url' ? ' selected' : '') + '>图片链接</option>' +
                '<option value="base64"' + (state.siteConfig.logo_type === 'base64' ? ' selected' : '') + '>上传图片</option>' +
              '</select>' +
            '</div>' +
            '<div class="form-group" id="logo-emoji-group"><label class="form-label">Logo Emoji</label><input type="text" class="form-input" id="cfg-logo-emoji" value="' + escapeHtml(state.siteConfig.logo_emoji || '📚') + '" placeholder="📚"></div>' +
            '<div class="form-group" id="logo-url-group" style="display:none"><label class="form-label">Logo 图片链接</label><input type="text" class="form-input" id="cfg-logo-url" value="' + (state.siteConfig.logo_type === 'url' ? escapeHtml(state.siteConfig.logo) : '') + '" placeholder="https://..."></div>' +
            '<div class="form-group" id="logo-upload-group" style="display:none"><label class="form-label">上传 Logo 图片</label><input type="file" class="form-input" id="cfg-logo-file" accept="image/*" onchange="handleLogoUpload(this)"><div class="form-hint">支持 JPG、PNG、GIF，建议 200x200 像素以内</div><div id="logo-preview" style="margin-top:8px"></div></div>' +
            '<button class="btn btn-primary" onclick="saveSiteSettings()">💾 保存网站配置</button>' +
          '</div>' +
          
          '<div class="config-section">' +
            '<div class="config-title">🤖 Telegram Bot 配置</div>' +
            '<div id="bot-status" style="margin-bottom:16px"></div>' +
            '<div class="form-group"><label class="form-label">Bot Token</label><input type="password" class="form-input" id="cfg-bot-token" placeholder="输入新 Token 或保留空白不修改"><div class="form-hint">从 @BotFather 获取</div></div>' +
            '<div class="form-group"><label class="form-label">允许的用户 ID</label><input type="text" class="form-input" id="cfg-allowed-users" placeholder="123456789, 987654321"><div class="form-hint">多个 ID 用英文逗号分隔，可在 @userinfobot 获取你的 ID</div></div>' +
            '<div class="form-group">' +
              '<label class="form-label">允许的频道 ID</label>' +
              '<input type="text" class="form-input" id="cfg-allowed-channels" placeholder="-1001234567890, -1009876543210"><div class="form-hint">多个 ID 用英文逗号分隔，频道 ID 通常是负数，格式为 -100xxxxxxxxxx</div>' +
            '</div>' +
            '<div class="form-row" style="margin-top:16px">' +
              '<button class="btn btn-primary" onclick="saveBotSettings()">💾 保存 Bot 配置</button>' +
              '<button class="btn btn-success" onclick="setupWebhook()">🔗 设置 Webhook</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    }
    
    function renderFooterConfigPage() {
      if (state.footerItems.length === 0 && state.siteConfig.footer_links && state.siteConfig.footer_links.length > 0) {
        syncFooterItems();
      }
      
      var cardsHtml = '';
      if (state.footerItems.length === 0) {
        cardsHtml = '<div style="text-align:center;padding:40px;color:var(--text-secondary);background:var(--bg);border-radius:12px;">暂无页脚链接，点击下方按钮添加</div>';
      } else {
        for (var i = 0; i < state.footerItems.length; i++) {
          var item = state.footerItems[i];
          var faviconService = item.favicon_service || '';
          cardsHtml += '<div class="footer-card" data-id="' + item.id + '">' +
            '<div class="footer-card-fields">' +
              '<div class="footer-card-field">' +
                '<label>显示文字 *</label>' +
                '<input type="text" class="footer-text" value="' + escapeHtml(item.text) + '" placeholder="链接名称">' +
              '</div>' +
              '<div class="footer-card-field">' +
                '<label>链接地址</label>' +
                '<div class="footer-card-row">' +
                  '<input type="text" class="footer-url" value="' + escapeHtml(item.url) + '" placeholder="https://example.com">' +
                  '<button class="btn btn-secondary" onclick="testFaviconForCard(' + item.id + ')">🔍 检测</button>' +
                '</div>' +
              '</div>' +
              '<div class="footer-card-field">' +
                '<label>图标（Emoji 或 图片URL，留空使用下方选择的服务自动获取）</label>' +
                '<input type="text" class="footer-icon" value="' + escapeHtml(item.icon) + '" placeholder="🔗 或 https://example.com/icon.png">' +
              '</div>' +
              '<div class="footer-card-field">' +
                '<label>Favicon 服务（图标留空时生效）</label>' +
                '<select class="footer-favicon-service form-select" style="padding:10px 14px">' +
                  '<option value="">自动选择最佳服务</option>' +
                  '<option value="duckduckgo"' + (faviconService === 'duckduckgo' ? ' selected' : '') + '>DuckDuckGo - 国际通用</option>' +
                  '<option value="yandex"' + (faviconService === 'yandex' ? ' selected' : '') + '>Yandex - 国内可访问</option>' +
                  '<option value="icon_horse"' + (faviconService === 'icon_horse' ? ' selected' : '') + '>Icon.Horse - 高质量</option>' +
                  '<option value="google"' + (faviconService === 'google' ? ' selected' : '') + '>Google - 需要外网</option>' +
                  '<option value="favicon_im"' + (faviconService === 'favicon_im' ? ' selected' : '') + '>Favicon.im - 备用</option>' +
                '</select>' +
              '</div>' +
              '<div class="favicon-test-results" id="favicon-results-' + item.id + '" style="display:none;margin-top:12px;padding:12px;background:var(--bg-card);border-radius:8px;border:1px solid var(--border);"></div>' +
            '</div>' +
            '<div class="footer-card-actions">' +
              '<button class="btn btn-danger" onclick="removeFooterCard(' + item.id + ')">🗑️ 删除</button>' +
            '</div>' +
          '</div>';
        }
      }
      
      return renderHeader(false) +
        '<div class="container" style="padding-top:24px;padding-bottom:40px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">' +
            '<h1>🔗 页脚配置</h1>' +
            '<button class="btn btn-secondary" onclick="navigate(\\'admin\\')">← 返回管理</button>' +
          '</div>' +
          
          '<div class="config-section">' +
            '<div class="config-title">页脚链接列表</div>' +
            '<div class="footer-cards" id="footer-cards">' + cardsHtml + '</div>' +
            '<div style="display:flex;gap:12px;margin-top:20px;">' +
              '<button class="btn btn-secondary" onclick="addFooterCard()">➕ 添加链接</button>' +
              '<button class="btn btn-primary" onclick="saveFooterConfig()">💾 保存页脚配置</button>' +
            '</div>' +
          '</div>' +
          
          '<div class="config-section">' +
            '<div class="config-title">预览效果</div>' +
            '<div id="footer-preview" style="background:var(--bg);border-radius:12px;padding:20px;">' +
              renderFooterPreview() +
            '</div>' +
          '</div>' +
        '</div>';
    }
    
    function renderFooterPreview() {
      if (state.footerItems.length === 0) {
        return '<p style="text-align:center;color:var(--text-secondary);">暂无链接</p>';
      }
      return '<div class="footer-links">' + state.footerItems.map(function(item) {
        return renderFooterLink({ icon: item.icon, text: item.text || '未填写', url: item.url, favicon: item.favicon });
      }).join('') + '</div>';
    }
    
    function renderLoginPage() {
      return '<div class="login-page"><div class="login-card">' +
        '<h1 class="login-title">🔐 管理后台</h1>' +
        '<p class="login-subtitle">' + escapeHtml(state.siteConfig.title) + '</p>' +
        '<div id="login-error" class="login-error" style="display:none"></div>' +
        '<div class="form-group"><label class="form-label" style="color:rgba(255,255,255,0.9)">管理密码</label><input type="password" class="form-input" id="login-password" placeholder="请输入密码"></div>' +
        '<button class="btn btn-primary" onclick="doLogin()">登 录</button>' +
        '<p style="text-align:center;margin-top:24px;"><a href="/" style="color:rgba(255,255,255,0.6);" onclick="event.preventDefault();navigate(\\'home\\')">← 返回首页</a></p>' +
        '</div></div>';
    }
    
    // ========== Event Bindings ==========
    function bindEvents() {
      var searchInput = $('#search-input');
      if (searchInput) {
        searchInput.addEventListener('keypress', function(e) { if (e.key === 'Enter') doSearch(); });
      }
      var loginPassword = $('#login-password');
      if (loginPassword) {
        loginPassword.addEventListener('keypress', function(e) { if (e.key === 'Enter') doLogin(); });
        loginPassword.focus();
      }
      if (state.page === 'config') {
        toggleLogoFields();
        loadBotConfigForEdit();
      }
    }
    
    // ========== Actions ==========
    function doSearch() {
      var q = $('#search-input').value.trim();
      searchItems(q);
    }
    
    function doLogin() {
      var password = $('#login-password').value;
      if (!password) return;
      showLoading();
      login(password).then(function(data) {
        hideLoading();
        if (data.success) {
          state.isAdmin = true;
          navigate('admin');
          showToast('登录成功');
        } else {
          $('#login-error').textContent = data.error || '密码错误';
          $('#login-error').style.display = 'block';
        }
      }).catch(function() {
        hideLoading();
        $('#login-error').textContent = '登录失败，请重试';
        $('#login-error').style.display = 'block';
      });
    }
    
    function refreshData() {
      showLoading();
      loadData().then(function() {
        hideLoading();
        render();
        showToast('数据已刷新');
      }).catch(function() {
        hideLoading();
        showToast('刷新失败');
      });
    }
    
    function showAddModal() {
      $('#modal-title').textContent = '添加收藏';
      $('#edit-id').value = '';
      $('#input-tags').value = '';
      $('#input-content').value = '';
      $('#add-modal').classList.add('show');
      $('#input-tags').focus();
    }
    
    function showEditModal(id) {
      var item = state.items.find(function(i) { return i.id === id; });
      if (!item) return;
      $('#modal-title').textContent = '编辑收藏';
      $('#edit-id').value = id;
      $('#input-tags').value = item.tags.join(', ');
      $('#input-content').value = item.content;
      $('#add-modal').classList.add('show');
    }
    
    function hideAddModal() {
      $('#add-modal').classList.remove('show');
    }
    
    function showDeleteConfirm(id) {
      deleteId = id;
      $('#confirm-modal').classList.add('show');
    }
    
    function hideConfirmModal() {
      deleteId = null;
      $('#confirm-modal').classList.remove('show');
    }
    
    function saveItem() {
      var id = $('#edit-id').value;
      var tags = $('#input-tags').value;
      var content = $('#input-content').value;
      if (!content.trim()) { showToast('内容不能为空'); return; }
      showLoading();
      var promise = id 
        ? apiCall('POST', '/api/edit/' + id, { tags: tags, content: content })
        : apiCall('POST', '/api/add', { tags: tags, content: content });
      promise.then(function(data) {
        hideLoading();
        if (data.success) {
          hideAddModal();
          loadData().then(function() { render(); });
          showToast(id ? '已更新' : '已添加');
        } else {
          showToast(data.error || '操作失败');
        }
      }).catch(function() { hideLoading(); showToast('操作失败'); });
    }
    
    function confirmDelete() {
      var idToDelete = deleteId;
      if (!idToDelete) return;
      hideConfirmModal();
      var card = document.getElementById('item-' + idToDelete);
      if (card) card.classList.add('removing');
      apiCall('POST', '/api/delete/' + idToDelete).then(function(data) {
        if (data.success) {
          state.items = state.items.filter(function(i) { return i.id !== idToDelete; });
          state.metadata.total_count = Math.max(0, (state.metadata.total_count || 0) - 1);
          showToast('已删除');
          setTimeout(function() { render(); }, 300);
        } else {
          showToast(data.error || '删除失败');
          render();
        }
      }).catch(function() { showToast('删除失败'); render(); });
    }
    
    // ========== Config Functions ==========
    function toggleLogoFields() {
      var type = $('#cfg-logo-type').value;
      $('#logo-emoji-group').style.display = type === 'emoji' ? 'block' : 'none';
      $('#logo-url-group').style.display = type === 'url' ? 'block' : 'none';
      $('#logo-upload-group').style.display = type === 'base64' ? 'block' : 'none';
    }
    
    function handleLogoUpload(input) {
      var file = input.files[0];
      if (!file) return;
      if (file.size > 100 * 1024) { showToast('图片不能超过 100KB'); return; }
      var reader = new FileReader();
      reader.onload = function(e) {
        var base64 = e.target.result;
        $('#logo-preview').innerHTML = '<img src="' + base64 + '" style="max-width:100px;max-height:100px;border-radius:8px">';
        $('#logo-preview').dataset.base64 = base64;
      };
      reader.readAsDataURL(file);
    }
    
    function saveSiteSettings() {
      var logoType = $('#cfg-logo-type').value;
      var config = {
        title: $('#cfg-title').value,
        description: $('#cfg-description').value,
        logo_type: logoType
      };
      if (logoType === 'emoji') {
        config.logo_emoji = $('#cfg-logo-emoji').value || '📚';
        config.logo = '';
      } else if (logoType === 'url') {
        config.logo = $('#cfg-logo-url').value;
      } else if (logoType === 'base64') {
        var preview = $('#logo-preview');
        if (preview.dataset.base64) config.logo = preview.dataset.base64;
      }
      showLoading();
      apiCall('POST', '/api/site-config', config).then(function(data) {
        hideLoading();
        if (data.success) {
          state.siteConfig = data.config;
          showToast('网站配置已保存');
          document.title = config.title + ' - ' + config.description;
        } else {
          showToast(data.error || '保存失败');
        }
      }).catch(function() { hideLoading(); showToast('保存失败'); });
    }
    
    function loadBotConfigForEdit() {
      fetch('/api/bot-config').then(function(res) { return res.json(); }).then(function(config) {
        $('#cfg-allowed-users').value = config.allowed_users || '';
        $('#cfg-allowed-channels').value = config.allowed_channels || '';
        var statusHtml = '';
        if (config.bot_token) {
          statusHtml += '<span class="status-badge success">✓ Token 已配置</span> ';
        } else {
          statusHtml += '<span class="status-badge warning">⚠ Token 未配置</span> ';
        }
        if (config.webhook_set) {
          statusHtml += '<span class="status-badge success">✓ Webhook 已设置</span>';
        } else {
          statusHtml += '<span class="status-badge warning">⚠ Webhook 未设置</span>';
        }
        $('#bot-status').innerHTML = statusHtml;
      });
    }
    
    function saveBotSettings() {
      var config = { 
        allowed_users: $('#cfg-allowed-users').value,
        allowed_channels: $('#cfg-allowed-channels').value
      };
      var token = $('#cfg-bot-token').value.trim();
      if (token) config.bot_token = token;
      showLoading();
      apiCall('POST', '/api/bot-config', config).then(function(data) {
        hideLoading();
        if (data.success) {
          showToast('Bot 配置已保存');
          $('#cfg-bot-token').value = '';
          loadBotConfigForEdit();
        } else {
          showToast(data.error || '保存失败');
        }
      }).catch(function() { hideLoading(); showToast('保存失败'); });
    }
    
    function setupWebhook() {
      showLoading();
      apiCall('POST', '/api/set-webhook', {}).then(function(data) {
        hideLoading();
        if (data.success) {
          showToast('Webhook 设置成功！已启用私聊和频道消息同步功能。');
          loadBotConfigForEdit();
        } else {
          showToast(data.error || 'Webhook 设置失败');
        }
      }).catch(function() { hideLoading(); showToast('Webhook 设置失败'); });
    }
    
    // ========== Footer Config Functions ==========
    function addFooterCard() {
      footerIdCounter++;
      state.footerItems.push({ id: footerIdCounter, icon: '', text: '', url: '', favicon: '', favicon_service: '' });
      
      var container = $('#footer-cards');
      if (!container) { render(); return; }
      
      if (state.footerItems.length === 1) {
        container.innerHTML = '';
      }
      
      var item = state.footerItems[state.footerItems.length - 1];
      var cardHtml = '<div class="footer-card" data-id="' + item.id + '">' +
        '<div class="footer-card-fields">' +
          '<div class="footer-card-field">' +
            '<label>显示文字 *</label>' +
            '<input type="text" class="footer-text" value="" placeholder="链接名称">' +
          '</div>' +
          '<div class="footer-card-field">' +
            '<label>链接地址</label>' +
            '<div class="footer-card-row">' +
              '<input type="text" class="footer-url" value="" placeholder="https://example.com">' +
              '<button class="btn btn-secondary" onclick="testFaviconForCard(' + item.id + ')">🔍 检测</button>' +
            '</div>' +
          '</div>' +
          '<div class="footer-card-field">' +
            '<label>图标（Emoji 或图片URL，留空自动获取）</label>' +
            '<input type="text" class="footer-icon" value="" placeholder="🔗 或 https://example.com/icon.png">' +
          '</div>' +
          '<div class="favicon-test-result" id="favicon-result-' + item.id + '" style="display:none;"></div>' +
        '</div>' +
        '<div class="footer-card-actions">' +
          '<button class="btn btn-danger" onclick="removeFooterCard(' + item.id + ')">🗑️ 删除</button>' +
        '</div>' +
      '</div>';
      
      container.insertAdjacentHTML('beforeend', cardHtml);
      updateFooterPreview();
      showToast('已添加新链接，请填写内容');
    }
    
    function testFaviconForCard(cardId) {
      var card = document.querySelector('.footer-card[data-id="' + cardId + '"]');
      if (!card) return;
      
      var urlInput = card.querySelector('.footer-url');
      var url = urlInput ? urlInput.value.trim() : '';
      
      if (!url) {
        showToast('请先输入链接地址');
        return;
      }
      
      var resultDiv = document.getElementById('favicon-result-' + cardId);
      if (!resultDiv) return;
      
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = '<div style="padding:12px;background:var(--bg);border-radius:8px;margin-top:8px;"><span style="color:var(--text-secondary)">🔄 正在检测...</span></div>';
      
      apiCall('POST', '/api/test-favicon', { url: url })
        .then(function(data) {
          if (data.error) {
            resultDiv.innerHTML = '<div style="padding:12px;background:var(--bg);border-radius:8px;margin-top:8px;color:var(--danger)">❌ ' + escapeHtml(data.error) + '</div>';
            return;
          }
          
          var html = '<div style="padding:12px;background:var(--bg);border-radius:8px;margin-top:8px;">';
          html += '<div style="margin-bottom:8px;font-size:12px;color:var(--text-secondary)">检测域名: ' + escapeHtml(data.domain) + '</div>';
          html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
          
          var results = data.results || {};
          Object.keys(results).forEach(function(key) {
            var r = results[key];
            var bgColor = r.success ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
            var textColor = r.success ? 'var(--success)' : 'var(--danger)';
            
            html += '<div style="padding:6px 10px;background:' + bgColor + ';border-radius:6px;display:flex;align-items:center;gap:4px;font-size:12px;">';
            if (r.success && r.favicon) {
              html += '<img src="' + r.favicon + '" style="width:14px;height:14px;" onerror="this.style.display=\\'none\\'">';
            }
            html += '<span style="color:' + textColor + '">' + escapeHtml(r.name) + '</span>';
            if (r.success) {
              html += '<button style="background:var(--primary);color:white;border:none;padding:2px 6px;border-radius:4px;font-size:10px;cursor:pointer;margin-left:4px" onclick="selectFavicon(' + cardId + ',\\'' + key + '\\')">选</button>';
            }
            html += '</div>';
          });
          
          html += '</div></div>';
          resultDiv.innerHTML = html;
        })
        .catch(function() {
          resultDiv.innerHTML = '<div style="padding:12px;background:var(--bg);border-radius:8px;margin-top:8px;color:var(--danger)">❌ 检测失败</div>';
        });
    }
    
    function selectFavicon(cardId, serviceKey) {
      var item = state.footerItems.find(function(i) { return i.id === cardId; });
      if (item) {
        item.favicon_service = serviceKey;
      }
      
      var resultDiv = document.getElementById('favicon-result-' + cardId);
      if (resultDiv) {
        resultDiv.innerHTML = '<div style="padding:12px;background:rgba(16,185,129,0.1);border-radius:8px;margin-top:8px;color:var(--success)">✓ 已选择 ' + serviceKey + '</div>';
        setTimeout(function() { resultDiv.style.display = 'none'; }, 2000);
      }
      
      showToast('已选择，保存后生效');
    }
    
    function updateFooterPreview() {
      var previewDiv = document.getElementById('footer-preview');
      if (previewDiv) {
        previewDiv.innerHTML = renderFooterPreview();
      }
    }
    
    function removeFooterCard(id) {
      state.footerItems = state.footerItems.filter(function(item) { return item.id !== id; });
      
      var card = document.querySelector('.footer-card[data-id="' + id + '"]');
      if (card) {
        card.remove();
      }
      
      var container = $('#footer-cards');
      if (container && state.footerItems.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);background:var(--bg);border-radius:12px;">暂无页脚链接，点击下方按钮添加</div>';
      }
      
      updateFooterPreview();
      showToast('已移除，记得保存');
    }
    
    function collectFooterData() {
      var cards = $$('.footer-card');
      var items = [];
      cards.forEach(function(card) {
        var cardId = parseInt(card.getAttribute('data-id'));
        var icon = card.querySelector('.footer-icon').value.trim();
        var text = card.querySelector('.footer-text').value.trim();
        var url = card.querySelector('.footer-url').value.trim();
        
        var stateItem = state.footerItems.find(function(i) { return i.id === cardId; });
        var faviconService = stateItem ? (stateItem.favicon_service || '') : '';
        
        if (text) {
          items.push({ 
            icon: icon, 
            text: text, 
            url: url,
            favicon_service: faviconService
          });
        }
      });
      return items;
    }
    
    function saveFooterConfig() {
      var links = collectFooterData();
      
      if (state.footerItems.length > 0 && links.length === 0) {
        showToast('请至少填写一个链接的显示文字');
        return;
      }
      
      showLoading();
      apiCall('POST', '/api/site-config', { footer_links: links }).then(function(data) {
        hideLoading();
        if (data.success) {
          state.siteConfig = data.config;
          syncFooterItems();
          showToast('页脚配置已保存');
          render();
        } else {
          showToast(data.error || '保存失败');
        }
      }).catch(function() { hideLoading(); showToast('保存失败'); });
    }
    
    // ========== Initialize ==========
    function init() {
      document.documentElement.className = state.theme;
      
      // 从页面获取初始数据
      var initScript = document.getElementById('init-data');
      if (initScript) {
        try {
          var initData = JSON.parse(initScript.textContent);
          state.items = initData.items || [];
          state.metadata = initData.metadata || {};
          state.siteConfig = initData.siteConfig || {};
          state.botConfigured = initData.botConfigured || false;
          state.version = initData.metadata?.version || 0;
          syncFooterItems();
        } catch (e) {
          console.error('Parse init data error:', e);
        }
      }
      
      var path = window.location.pathname;
      var params = new URLSearchParams(window.location.search);
      if (params.get('tag')) state.currentTag = params.get('tag');
      if (params.get('source')) state.currentSource = params.get('source');
      if (params.get('q')) state.currentQ = params.get('q');
      
      if (path === '/admin' || path === '/admin/') {
        state.page = 'admin';
        checkAuth().then(function(data) { 
          state.isAdmin = data.authenticated; 
          render(); 
        });
      } else if (path === '/tags' || path === '/tags/') {
        state.page = 'tags';
        render();
      } else if (path === '/config' || path === '/config/') {
        state.page = 'config';
        checkAuth().then(function(data) { state.isAdmin = data.authenticated; render(); });
      } else if (path === '/footer' || path === '/footer/') {
        state.page = 'footer';
        checkAuth().then(function(data) { state.isAdmin = data.authenticated; render(); });
      } else {
        state.page = 'home';
        render();
      }
      
      window.addEventListener('popstate', function() {
        var path = window.location.pathname;
        var params = new URLSearchParams(window.location.search);
        state.currentTag = params.get('tag') || '';
        state.currentSource = params.get('source') || '';
        state.currentQ = params.get('q') || '';
        if (path === '/admin' || path === '/admin/') state.page = 'admin';
        else if (path === '/tags' || path === '/tags/') state.page = 'tags';
        else if (path === '/config' || path === '/config/') state.page = 'config';
        else if (path === '/footer' || path === '/footer/') state.page = 'footer';
        else state.page = 'home';
        render();
      });
    }
    
    init();
  <\/script>
</body>
</html>`;
}

// ============== 主入口 ==============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Telegram Webhook
      if (path === '/telegram-webhook' && method === 'POST') {
        return handleTelegramWebhook(request, env);
      }
      
      // 管理登录
      if (path === '/admin/login' && method === 'POST') {
        return handleAdminLogin(request, env);
      }
      
      // 管理登出
      if (path === '/admin/logout') {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': 'admin_token=; Path=/; Max-Age=0'
          }
        });
      }
      
      // API 路由
      if (path === '/api/data' && method === 'GET') {
        return handleApiData(request, env, url);
      }
      
      if (path === '/api/tags' && method === 'GET') {
        return handleApiTags(env);
      }
      
      if (path === '/api/auth' && method === 'GET') {
        return handleCheckAuth(request, env);
      }
      
      if (path === '/api/site-config') {
        return handleApiSiteConfig(request, env);
      }
      
      if (path === '/api/bot-config') {
        return handleApiBotConfig(request, env);
      }
      
      if (path === '/api/set-webhook' && method === 'POST') {
        return handleApiSetWebhook(request, env);
      }
      
      if (path === '/api/test-favicon' && method === 'POST') {
        return handleApiTestFavicon(request);
      }
      
      if (path === '/api/favicon-services' && method === 'GET') {
        return handleApiGetFaviconServices();
      }
      
      if (path === '/api/add' && method === 'POST') {
        return handleApiAdd(request, env);
      }
      
      if (path.startsWith('/api/edit/') && method === 'POST') {
        const id = path.replace('/api/edit/', '');
        return handleApiEdit(request, env, id);
      }
      
      if (path.startsWith('/api/delete/') && method === 'POST') {
        const id = path.replace('/api/delete/', '');
        return handleApiDelete(request, env, id);
      }
      
      // 所有其他 GET 请求返回 SPA
      if (method === 'GET') {
        const html = await renderSPA(env);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      
      return new Response('Method not allowed', { status: 405 });
      
    } catch (error) {
      console.error('Error:', error);
      return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
  }
};