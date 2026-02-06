
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
    // 使用 cacheTtl: 60 秒，符合 Cloudflare KV 最小要求
    const data = await env.NAV_KV.get('collections', { type: 'json', cacheTtl: 60 });
    return data || [];
  } catch (e) {
    console.error('getCollections error:', e);
    return [];
  }
}

async function saveCollections(env, collections) {
  try {
    // 写入时设置较短的 TTL，加快全球同步
    await env.NAV_KV.put('collections', JSON.stringify(collections), {
      expirationTtl: 31536000 // 1 年后过期（实际上永不过期）
    });
    return true;
  } catch (e) {
    console.error('saveCollections error:', e);
    return false;
  }
}

async function getMetadata(env) {
  try {
    // 同样优化 metadata 读取
    const data = await env.NAV_KV.get('metadata', { type: 'json', cacheTtl: 60 });
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
    const data = await env.NAV_KV.get('site_config', { type: 'json', cacheTtl: 300 });
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
    const data = await env.NAV_KV.get('bot_config', { type: 'json', cacheTtl: 300 });
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
    const data = await env.NAV_KV.get(`tags_${tag}`, { type: 'json', cacheTtl: 60 });
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

// ============== 媒体组缓存 ==============

async function getMediaGroupCache(env, mediaGroupId) {
  try {
    const data = await env.NAV_KV.get(`media_group_${mediaGroupId}`, { type: 'json', cacheTtl: 60 });
    return data || null;
  } catch (e) {
    return null;
  }
}

async function saveMediaGroupCache(env, mediaGroupId, messages) {
  try {
    // 媒体组缓存保持 60 秒，足够收集所有消息
    await env.NAV_KV.put(`media_group_${mediaGroupId}`, JSON.stringify(messages), { expirationTtl: 60 });
  } catch (e) {
    console.error('saveMediaGroupCache error:', e);
  }
}

async function deleteMediaGroupCache(env, mediaGroupId) {
  try {
    await env.NAV_KV.delete(`media_group_${mediaGroupId}`);
  } catch (e) {
    console.error('deleteMediaGroupCache error:', e);
  }
}

// ============== 数据操作 ==============

async function addItem(env, tags, content, source = 'web', sourceInfo = null, telegramMsgInfo = null, mediaInfo = null) {
  const id = generateId();
  const item = {
    id,
    tags,
    content,
    source,
    source_info: sourceInfo,
    telegram_msg: telegramMsgInfo,
    media: mediaInfo,  // 现在可以是单个对象或数组
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
  const mediaGroupId = message.media_group_id;
  
  console.log('Channel post from:', chatId, 'title:', chatTitle, 'media_group_id:', mediaGroupId);
  
  // 验证频道权限
  if (!isAllowedChannel(chatId.toString(), botConfig.allowed_channels)) {
    console.log('Channel not allowed:', chatId);
    return { ok: true };
  }
  
  // 如果是媒体组消息，需要收集所有消息
  if (mediaGroupId) {
    return await handleMediaGroupMessage(env, message, botConfig, 'channel');
  }
  
  // 处理单个媒体文件或贴纸
  let mediaInfo = null;
  if (message.photo || message.audio || message.voice || message.document || message.video || message.sticker) {
    mediaInfo = await processMediaFile(message, botConfig.bot_token, chatId);
  }
  
  // 提取内容并转换为标准 Markdown
  let content = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  
  if (entities.length > 0) {
    content = restoreEntities(content, entities, 'std');
  }
  
  // 允许纯媒体消息（无文字）
  if (!content.trim() && !mediaInfo) {
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
  const item = await addItem(env, finalTags, content, 'telegram_channel', sourceInfo, telegramMsgInfo, mediaInfo);
  
  console.log('Channel post saved:', item.id);
  
  return { ok: true };
}

// 处理媒体组消息（相册）
// Telegram 发送媒体组时会快速连续发送多个请求
// 我们收集所有消息，然后在 waitUntil 中延迟处理
async function handleMediaGroupMessage(env, message, botConfig, chatType = 'channel') {
  const mediaGroupId = message.media_group_id;
  
  console.log('Media group message:', mediaGroupId, 'message_id:', message.message_id);
  
  // 获取当前缓存的媒体组消息
  let groupCache = await getMediaGroupCache(env, mediaGroupId);
  
  if (!groupCache) {
    groupCache = {
      messages: [],
      firstMessageTime: Date.now(),
      processed: false
    };
  }
  
  // 检查是否已经包含这条消息（避免重复）
  const exists = groupCache.messages.find(m => m.message_id === message.message_id);
  if (exists) {
    console.log('Media group:', mediaGroupId, 'message already exists:', message.message_id);
    return { ok: true };
  }
  
  // 添加当前消息到缓存
  groupCache.messages.push(message);
  const messageCount = groupCache.messages.length;
  
  console.log('Media group:', mediaGroupId, 'collected:', messageCount, 'messages');
  
  // 保存缓存
  await saveMediaGroupCache(env, mediaGroupId, groupCache);
  
  // 如果达到10条（Telegram最大限制），立即处理
  if (messageCount >= 10 && !groupCache.processed) {
    console.log('Media group:', mediaGroupId, 'reached max (10), processing immediately');
    await finalizeMediaGroup(env, mediaGroupId, botConfig, chatType);
  }
  // 否则等待 waitUntil 延迟处理
  
  return { ok: true };
}

// 最终处理媒体组
async function finalizeMediaGroup(env, mediaGroupId, botConfig, chatType) {
  const groupCache = await getMediaGroupCache(env, mediaGroupId);
  
  if (!groupCache || groupCache.processed) {
    console.log('Media group:', mediaGroupId, 'already processed or not found');
    return;
  }
  
  // 标记为已处理
  groupCache.processed = true;
  await saveMediaGroupCache(env, mediaGroupId, groupCache);
  
  console.log('Finalizing media group:', mediaGroupId, 'with', groupCache.messages.length, 'messages');
  
  // 处理媒体组
  await processMediaGroup(env, groupCache.messages, botConfig, chatType);
  
  // 删除缓存
  await deleteMediaGroupCache(env, mediaGroupId);
}

// 处理收集完成的媒体组
async function processMediaGroup(env, messages, botConfig, chatType) {
  if (messages.length === 0) return;
  
  // 按消息 ID 排序
  messages.sort((a, b) => a.message_id - b.message_id);
  
  const firstMessage = messages[0];
  const chatId = firstMessage.chat.id;
  const chatTitle = firstMessage.chat.title || firstMessage.chat.first_name;
  
  // 收集所有媒体
  const mediaArray = [];
  for (const msg of messages) {
    const mediaInfo = await processMediaFile(msg, botConfig.bot_token, chatId);
    if (mediaInfo) {
      mediaArray.push(mediaInfo);
    }
  }
  
  // 提取第一条消息的文字内容
  let content = messages[0].text || messages[0].caption || '';
  const entities = messages[0].entities || messages[0].caption_entities || [];
  
  if (entities.length > 0) {
    content = restoreEntities(content, entities, 'std');
  }
  
  // 解析标签
  const tags = parseTags(content);
  const finalTags = tags.length > 0 ? tags : (chatType === 'channel' ? ['channel'] : ['media']);
  
  // 频道消息添加频道标签
  if (chatType === 'channel' && chatTitle) {
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
    message_id: firstMessage.message_id,
    chat_type: chatType,
    channel_title: chatType === 'channel' ? chatTitle : null,
    media_group_id: firstMessage.media_group_id
  };
  
  // 保存来源信息
  let sourceInfo;
  if (chatType === 'channel') {
    sourceInfo = {
      channel_id: chatId.toString(),
      channel_title: chatTitle,
      channel_username: firstMessage.chat.username || null,
      type: 'channel'
    };
  } else {
    // 私聊消息 - 检查是否是转发
    if (firstMessage.forward_from) {
      sourceInfo = {
        username: firstMessage.forward_from.username || null,
        first_name: firstMessage.forward_from.first_name || 'Unknown',
        user_id: firstMessage.forward_from.id.toString()
      };
    } else if (firstMessage.forward_from_chat) {
      sourceInfo = {
        username: firstMessage.forward_from_chat.username || null,
        first_name: firstMessage.forward_from_chat.title || 'Unknown',
        user_id: firstMessage.forward_from_chat.id.toString()
      };
    } else if (firstMessage.forward_sender_name) {
      sourceInfo = {
        username: null,
        first_name: firstMessage.forward_sender_name,
        user_id: 'hidden'
      };
    } else {
      sourceInfo = {
        user_id: firstMessage.from.id.toString(),
        first_name: firstMessage.from.first_name,
        username: firstMessage.from.username || null,
        type: 'user'
      };
    }
  }
  
  // 保存收藏项（媒体为数组）
  const item = await addItem(
    env,
    finalTags,
    content,
    chatType === 'channel' ? 'telegram_channel' : (firstMessage.forward_from || firstMessage.forward_from_chat ? 'telegram_forward' : 'telegram'),
    sourceInfo,
    telegramMsgInfo,
    mediaArray  // 传入媒体数组
  );
  
  console.log('Media group saved:', item.id, 'media count:', mediaArray.length);
  
  // 如果是私聊，发送确认消息给用户
  if (chatType === 'user') {
    const tagsText = finalTags.map(t => `#${t}`).join(' ');
    let sourceText = '';
    if (firstMessage.forward_from || firstMessage.forward_from_chat || firstMessage.forward_sender_name) {
      if (sourceInfo.username) sourceText = `\n📥 转发自: @${sourceInfo.username}`;
      else if (sourceInfo.first_name) sourceText = `\n📥 转发自: ${sourceInfo.first_name}`;
    }
    
    const mediaCountText = `${mediaArray.length} 个媒体文件`;
    const previewContent = content ? (content.substring(0, 80).replace(/\n/g, ' ').replace(/```[\s\S]*?```/g, '[代码块]')) : mediaCountText;
    
    await sendMessage(botConfig.bot_token, chatId,
      `✅ <b>已添加！</b>\n\n🏷️ ${tagsText}${sourceText}\n📝 ${escapeHtml(previewContent)}${content && content.length > 80 ? '...' : ''}\n\n<i>💡 提示：编辑原消息可自动同步更新</i>`,
      {
        reply_to_message_id: firstMessage.message_id,
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
    // state 需要即时读取，使用 cacheTtl: 60（最小允许值）
    state = await env.NAV_KV.get(stateKey, { type: 'json', cacheTtl: 60 });
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

// 处理媒体文件（图片、音频、文档、视频、贴纸等）
async function processMediaFile(message, botToken, chatId) {
  let fileInfo = null;
  let mediaType = null;
  let fileName = null;
  let fileSize = 0;
  
  // 识别媒体类型
  if (message.photo) {
    // 获取最大尺寸的图片
    const photos = message.photo.sort((a, b) => b.file_size - a.file_size);
    fileInfo = photos[0];
    mediaType = 'photo';
    fileSize = fileInfo.file_size || 0;
  } else if (message.sticker) {
    // 处理贴纸
    fileInfo = message.sticker;
    mediaType = 'sticker';
    fileName = 'sticker';
    fileSize = fileInfo.file_size || 0;
  } else if (message.audio) {
    fileInfo = message.audio;
    mediaType = 'audio';
    fileName = fileInfo.file_name || fileInfo.title || 'audio';
    fileSize = fileInfo.file_size || 0;
  } else if (message.voice) {
    fileInfo = message.voice;
    mediaType = 'voice';
    fileName = 'voice_message.ogg';
    fileSize = fileInfo.file_size || 0;
  } else if (message.video) {
    fileInfo = message.video;
    mediaType = 'video';
    fileName = fileInfo.file_name || 'video';
    fileSize = fileInfo.file_size || 0;
  } else if (message.document) {
    fileInfo = message.document;
    mediaType = 'document';
    fileName = fileInfo.file_name || 'document';
    fileSize = fileInfo.file_size || 0;
  }
  
  if (!fileInfo) return null;
  
  // 生成 Telegram 消息链接
  let telegramLink = null;
  if (message.chat && message.chat.username) {
    telegramLink = `https://t.me/${message.chat.username}/${message.message_id}`;
  } else {
    telegramLink = `https://t.me/c/${Math.abs(chatId)}/${message.message_id}`;
  }
  
  // 所有媒体文件（包括图片）都使用 file_id 通过代理访问，不再下载 base64
  // 这样可以节省大量 KV 存储空间
  return {
    type: mediaType,
    fileName: fileName,
    fileSize: fileSize,
    fileId: fileInfo.file_id,  // 保存 file_id 用于代理访问
    telegramLink: telegramLink,
    mimeType: fileInfo.mime_type || null,
    duration: fileInfo.duration || null,
    width: fileInfo.width || null,
    height: fileInfo.height || null,
    // 贴纸特殊属性
    emoji: message.sticker ? message.sticker.emoji : null,
    isAnimated: message.sticker ? message.sticker.is_animated : false,
    isVideo: message.sticker ? message.sticker.is_video : false,
    thumbnail: fileInfo.thumbnail ? fileInfo.thumbnail.file_id : null
  };
}

async function handleAddContent(env, chatId, message, botConfig) {
  const mediaGroupId = message.media_group_id;
  
  // 如果是媒体组消息，使用媒体组处理逻辑
  if (mediaGroupId) {
    return await handleMediaGroupMessage(env, message, botConfig, 'user');
  }
  
  let content = message.text || message.caption || '';
  let sourceInfo = null;
  let mediaInfo = null;
  
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
  
  // 处理媒体文件（图片、音频、文档、视频、贴纸等）
  if (message.photo || message.audio || message.voice || message.document || message.video || message.sticker) {
    mediaInfo = await processMediaFile(message, botConfig.bot_token, chatId);
  }
  
  // 使用 restoreEntities 转换 Telegram entities 为标准 Markdown
  const entities = message.entities || message.caption_entities || [];
  if (entities.length > 0) {
    content = restoreEntities(content, entities, 'std');
  }
  
  // 允许纯媒体消息（无文字）
  if (!content.trim() && !mediaInfo) {
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
  
  const item = await addItem(env, finalTags, content, sourceInfo ? 'telegram_forward' : 'telegram', sourceInfo, telegramMsgInfo, mediaInfo);
  
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

async function handleTelegramWebhook(request, env, ctx) {
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
    
    // 立即处理更新
    await handleTelegramUpdate(env, update, botConfig);
    
    // 如果是媒体组消息，使用 waitUntil 延迟检查是否需要最终处理
    const message = update.message || update.channel_post;
    if (message && message.media_group_id) {
      const mediaGroupId = message.media_group_id;
      const chatType = update.channel_post ? 'channel' : 'user';
      
      // 使用 waitUntil 延迟 2 秒后检查并处理媒体组
      ctx.waitUntil(
        (async () => {
          // 等待 2 秒
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // 检查并处理媒体组
          const groupCache = await getMediaGroupCache(env, mediaGroupId);
          if (groupCache && !groupCache.processed) {
            console.log('WaitUntil: Processing media group', mediaGroupId, 'with', groupCache.messages.length, 'messages');
            await finalizeMediaGroup(env, mediaGroupId, botConfig, chatType);
          }
        })()
      );
    }
    
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

// 文件代理 API - 安全地转发 Telegram 文件
async function handleApiFileProxy(request, env, fileId) {
  try {
    // 验证 file_id 格式（基本防护）
    if (!fileId || typeof fileId !== 'string' || fileId.length > 200) {
      return new Response('Invalid file ID', { status: 400 });
    }
    
    // 获取 Bot Token
    const botConfig = await getBotConfig(env);
    if (!botConfig.bot_token) {
      return new Response('Bot not configured', { status: 500 });
    }
    
    // 从 Telegram 获取文件路径
    const filePathResponse = await fetch(`https://api.telegram.org/bot${botConfig.bot_token}/getFile?file_id=${fileId}`);
    const filePathData = await filePathResponse.json();
    
    if (!filePathData.ok || !filePathData.result.file_path) {
      return new Response('File not found', { status: 404 });
    }
    
    // 下载文件
    const fileUrl = `https://api.telegram.org/file/bot${botConfig.bot_token}/${filePathData.result.file_path}`;
    const fileResponse = await fetch(fileUrl);
    
    if (!fileResponse.ok) {
      return new Response('Failed to download file', { status: 502 });
    }
    
    // 转发文件，保留原始的 Content-Type
    const headers = new Headers();
    headers.set('Content-Type', fileResponse.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment');
    headers.set('Cache-Control', 'public, max-age=31536000'); // 缓存 1 年
    
    return new Response(fileResponse.body, {
      status: 200,
      headers: headers
    });
  } catch (e) {
    console.error('File proxy error:', e);
    return new Response('Internal server error', { status: 500 });
  }
}

async function handleApiData(request, env, url) {
  const tag = url.searchParams.get('tag');
  const source = url.searchParams.get('source');
  const q = url.searchParams.get('q');
  
  const metadata = await getMetadata(env);
  const siteConfig = await getSiteConfig(env);
  const collections = await getCollections(env);
  const botConfig = await getBotConfig(env);
  
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
    siteConfig,
    botConfigured: !!botConfig.bot_token && botConfig.webhook_set
  }, 200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'CDN-Cache-Control': 'no-store'
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

// ========== PWA Support ==========
async function handleManifest(env) {
  const siteConfig = await getSiteConfig(env);
  
  const manifest = {
    name: siteConfig.title || 'NavCollect',
    short_name: siteConfig.title || 'NavCollect',
    description: siteConfig.description || '个人网站导航收藏系统',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#6366f1',
    icons: [
      {
        src: siteConfig.logo || '/icon-192.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: siteConfig.logo || '/icon-512.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
  };
  
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

async function handleServiceWorker() {
  const sw = `
// Service Worker for NavCollect PWA
const CACHE_NAME = 'navcollect-v1';
const urlsToCache = [
  '/',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
`;
  
  return new Response(sw, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

async function renderSPA(env) {
  // 只获取基础配置（用于页面元信息和 Logo）
  const siteConfig = await getSiteConfig(env);

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
  
  <!-- PWA Meta Tags -->
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="${escapeHtml(siteConfig.title)}">
  <meta name="theme-color" content="#6366f1">
  <link rel="manifest" href="/manifest.json">
  
  <link rel="icon" href="${faviconHref}">
  <!-- 引入 marked.js 和 highlight.js -->
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
  <!-- 引入 Plyr (轻量级音视频播放器) -->
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
  <script src="https://cdn.plyr.io/3.7.8/plyr.js"></script>
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
    /* 标签云样式 - 大号、描边、浅色 */
    .tag-chip {
      padding: 8px 16px;
      background: var(--bg);
      border: 1.5px solid var(--border);
      border-radius: 24px;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .tag-chip:hover { 
      border-color: var(--primary); 
      color: var(--primary); 
      transform: translateY(-1px);
      box-shadow: 0 2px 6px rgba(99, 102, 241, 0.15);
    }
    .tag-chip.active { 
      background: var(--primary); 
      border-color: var(--primary); 
      color: white;
      box-shadow: 0 2px 6px rgba(99, 102, 241, 0.3);
    }
    
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
    
    .item-header { 
      display: flex; 
      align-items: flex-start; 
      justify-content: flex-end; 
      gap: 12px; 
      margin-bottom: 0;
    }
    
    /* 标签区域 - 标题和操作在同一行 */
    .item-tags-section {
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border-left: 3px solid var(--primary);
      padding: 12px 14px;
      margin-bottom: 12px;
      border-radius: 8px;
    }
    .dark .item-tags-section {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.5) 0%, rgba(15, 23, 42, 0.5) 100%);
      border-left-color: #6366f1;
    }
    
    /* 标签头部：标题和操作按钮 */
    .tags-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .tags-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    /* 标签列表 */
    .item-tags { 
      display: flex; 
      flex-wrap: wrap; 
      gap: 8px; /* 增加标签间距从 6px 到 8px */
      line-height: 1.8; /* 增加行高，让换行时垂直间距更大 */
    }
    
    /* 内容标签样式 - 小号、紧凑、渐变 */
    .item-tag {
      padding: 4px 10px; /* 增加内边距，从 3px 8px 改为 4px 10px */
      background: linear-gradient(135deg, #eef2ff 0%, #dbeafe 100%);
      color: #4f46e5;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      letter-spacing: 0.3px;
      box-shadow: 0 1px 2px rgba(99, 102, 241, 0.1);
      margin: 2px 0; /* 增加上下外边距，让垂直方向更宽松 */
    }
    .dark .item-tag { 
      background: linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(59,130,246,0.25) 100%);
      color: #a5b4fc;
    }
    .item-tag:hover { 
      background: linear-gradient(135deg, var(--primary) 0%, #4f46e5 100%);
      color: white;
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(99, 102, 241, 0.3);
    }
    .item-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s; }
    .item-card:hover .item-actions { opacity: 1; }
    
    /* 桌面端：默认显示操作按钮 */
    @media (min-width: 769px) {
      .item-actions { opacity: 1; }
    }
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
      margin: 2px 3px; /* 增加上下左右间距 */
    }
    .dark .inline-tag { background: rgba(99,102,241,0.2); }
    .inline-tag:hover { background: var(--primary); color: white; }
    
    /* 媒体容器样式 */
    .media-container {
      margin: 16px 0;
      border-radius: 12px;
      overflow: hidden;
    }
    
    /* 媒体组样式 */
    .media-group {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    
    /* 图片轮播 */
    .photo-carousel {
      position: relative;
      width: 100%;
      background: var(--bg);
      border-radius: 12px;
      overflow: hidden;
    }
    .carousel-track {
      position: relative;
      width: 100%;
      height: 0;
      padding-bottom: 75%; /* 4:3 宽高比 */
    }
    .carousel-slide {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
      pointer-events: none;
    }
    .carousel-slide.active {
      opacity: 1;
      pointer-events: auto;
    }
    .carousel-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
      cursor: pointer;
      background: var(--bg);
    }
    .carousel-btn {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(0, 0, 0, 0.5);
      color: white;
      border: none;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      font-size: 24px;
      cursor: pointer;
      z-index: 10;
      transition: background 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .carousel-btn:hover {
      background: rgba(0, 0, 0, 0.8);
    }
    .carousel-prev { left: 10px; }
    .carousel-next { right: 10px; }
    .carousel-indicators {
      position: absolute;
      bottom: 10px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      z-index: 10;
    }
    .carousel-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.5);
      cursor: pointer;
      transition: background 0.2s;
    }
    .carousel-indicator.active {
      background: white;
    }
    
    /* 视频网格 */
    .video-grid {
      display: grid;
      gap: 12px;
      width: 100%;
    }
    .video-grid-1col {
      grid-template-columns: 1fr;
    }
    .video-grid-2col {
      grid-template-columns: repeat(2, 1fr);
    }
    .video-grid-3col {
      grid-template-columns: repeat(3, 1fr);
    }
    .video-grid-item {
      background: var(--bg);
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .video-grid-item video {
      width: 100%;
      height: auto;
      display: block;
    }
    
    /* 贴纸样式 */
    .media-sticker {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 12px;
      background: var(--bg);
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .sticker-image {
      max-width: 200px;
      max-height: 200px;
      width: auto;
      height: auto;
    }
    .sticker-emoji {
      font-size: 20px;
    }
    
    /* 单张图片样式 */
    .media-image {
      max-width: 100%;
      height: auto;
      border-radius: 12px;
      cursor: pointer;
      transition: transform 0.2s;
      display: block;
    }
    .media-image:hover {
      transform: scale(1.02);
    }
    
    /* 响应式：移动端视频网格调整 */
    @media (max-width: 768px) {
      .video-grid-3col {
        grid-template-columns: repeat(2, 1fr);
      }
      .carousel-btn {
        width: 32px;
        height: 32px;
        font-size: 20px;
      }
    }
    
    /* 图片预览弹窗 */
    .image-viewer-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.95);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.2s ease-in-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .image-viewer-content {
      position: relative;
      max-width: 90vw;
      max-height: 90vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .image-viewer-img {
      max-width: 100%;
      max-height: 90vh;
      object-fit: contain;
      border-radius: 8px;
    }
    .image-viewer-close {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 40px;
      height: 40px;
      background: rgba(255, 255, 255, 0.2);
      border: none;
      border-radius: 50%;
      color: white;
      font-size: 24px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
      z-index: 10000;
    }
    .image-viewer-close:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    .image-viewer-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 50px;
      height: 50px;
      background: rgba(255, 255, 255, 0.2);
      border: none;
      border-radius: 50%;
      color: white;
      font-size: 28px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    .image-viewer-nav:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    .image-viewer-nav.prev {
      left: 20px;
    }
    .image-viewer-nav.next {
      right: 20px;
    }
    .image-viewer-counter {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.6);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
    }
    .media-audio {
      padding: 16px;
      background: var(--bg);
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .media-video {
      background: var(--bg);
      border-radius: 12px;
      border: 1px solid var(--border);
      overflow: hidden;
    }
    
    /* Plyr 播放器样式定制 */
    .plyr {
      --plyr-color-main: #6366f1;
      --plyr-video-background: #000;
      --plyr-menu-background: rgba(0, 0, 0, 0.9);
      --plyr-menu-color: #fff;
    }
    .plyr--audio .plyr__controls {
      background: transparent;
      padding: 8px 0;
    }
    .plyr--video .plyr__control--overlaid {
      background: rgba(99, 102, 241, 0.9);
      border-radius: 50%;
      padding: 20px;
    }
    .plyr--video .plyr__control--overlaid:hover {
      background: rgba(99, 102, 241, 1);
    }
    .plyr__control--overlaid svg {
      width: 32px;
      height: 32px;
    }
    
    .media-filename {
      margin-top: 8px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .media-file {
      padding: 12px 16px;
      background: var(--bg);
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .media-link {
      color: var(--primary);
      text-decoration: none;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .media-link:hover {
      text-decoration: underline;
    }
    
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
    
    /* 列表控件 */
    .list-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .sort-controls, .page-size-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .control-label {
      font-size: 14px;
      color: var(--text-secondary);
      white-space: nowrap;
    }
    .control-select {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .control-select:hover {
      border-color: var(--primary);
    }
    .control-select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }
    .items-count {
      font-size: 14px;
      color: var(--text-secondary);
      margin-left: auto;
    }
    
    /* 分页 */
    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 32px;
      padding: 20px;
      flex-wrap: wrap;
    }
    .page-btn {
      min-width: 40px;
      height: 40px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
      color: var(--text);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .page-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      transform: translateY(-1px);
    }
    .page-btn.active {
      background: var(--primary);
      border-color: var(--primary);
      color: white;
    }
    .page-btn.active:hover {
      transform: none;
    }
    .page-ellipsis {
      color: var(--text-secondary);
      padding: 0 4px;
    }
    
    /* 图片懒加载 */
    .lazy-image {
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    .lazy-loaded {
      opacity: 1;
    }
    
    /* 紧凑型工具栏样式 */
    .compact-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .group-label {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 500;
      margin-right: 4px;
    }
    .compact-btn {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .compact-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      transform: translateY(-1px);
    }
    .compact-btn.primary {
      background: var(--primary);
      border-color: var(--primary);
      color: white;
    }
    .compact-btn.primary:hover {
      background: #4f46e5;
    }
    .compact-btn.danger {
      background: #fee;
      border-color: #fcc;
      color: #c33;
    }
    .compact-btn.danger:hover {
      background: #fcc;
    }
    .compact-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .compact-btn.icon-btn {
      position: relative;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .notification-dot {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 8px;
      height: 8px;
      background: #ef4444;
      border-radius: 50%;
      border: 2px solid var(--bg-card);
    }
    .compact-select {
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .compact-select:hover {
      border-color: var(--primary);
    }
    .compact-select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }
    
    /* 紧凑型下拉菜单 */
    .compact-dropdown {
      position: relative;
    }
    .compact-menu {
      display: none;
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 6px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow-lg);
      min-width: 140px;
      z-index: 100;
      overflow: hidden;
    }
    .compact-dropdown:hover .compact-menu {
      display: block;
    }
    .compact-menu button {
      display: block;
      width: 100%;
      padding: 8px 14px;
      border: none;
      background: transparent;
      color: var(--text);
      text-align: left;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .compact-menu button:hover {
      background: var(--bg);
    }
    
    /* 抽屉式筛选面板 */
    .filter-drawer {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 9999;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .filter-drawer.open {
      opacity: 1;
      pointer-events: auto;
    }
    .filter-drawer-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
    }
    .filter-drawer-content {
      position: absolute;
      top: 0;
      right: 0;
      width: 100%;
      max-width: 400px;
      height: 100%;
      background: var(--bg);
      box-shadow: var(--shadow-lg);
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .filter-drawer.open .filter-drawer-content {
      transform: translateX(0);
    }
    .filter-drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-card);
    }
    .filter-drawer-header h3 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--text);
    }
    .filter-close {
      width: 36px;
      height: 36px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 28px;
      cursor: pointer;
      border-radius: 8px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .filter-close:hover {
      background: var(--bg);
      color: var(--text);
    }
    .filter-drawer-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }
    .filter-section {
      margin-bottom: 24px;
    }
    .filter-section:last-child {
      margin-bottom: 0;
    }
    .filter-section-label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 10px;
    }
    .filter-drawer-select,
    .filter-drawer-input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
      color: var(--text);
      font-size: 14px;
      transition: all 0.2s;
    }
    .filter-drawer-select:hover,
    .filter-drawer-input:hover {
      border-color: var(--primary);
    }
    .filter-drawer-select:focus,
    .filter-drawer-input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }
    .filter-date-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .filter-date-sep {
      color: var(--text-secondary);
      font-size: 14px;
      flex-shrink: 0;
    }
    .filter-shortcuts {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .filter-shortcut {
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-card);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .filter-shortcut:hover {
      border-color: var(--primary);
      background: rgba(99, 102, 241, 0.1);
      color: var(--primary);
    }
    .filter-drawer-footer {
      padding: 16px 20px;
      border-top: 1px solid var(--border);
      background: var(--bg-card);
      display: flex;
      gap: 12px;
    }
    .filter-drawer-btn {
      flex: 1;
      padding: 12px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .filter-drawer-btn.primary {
      background: var(--primary);
      color: white;
    }
    .filter-drawer-btn.primary:hover {
      background: #4f46e5;
      transform: translateY(-1px);
    }
    .filter-drawer-btn.secondary {
      background: transparent;
      color: var(--primary);
      border: 1px solid var(--primary);
    }
    .filter-drawer-btn.secondary:hover {
      background: rgba(99, 102, 241, 0.1);
    }
    
    /* 旧样式保留（向后兼容） */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .toolbar-btn {
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .toolbar-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
      transform: translateY(-1px);
    }
    .toolbar-btn.primary {
      background: var(--primary);
      border-color: var(--primary);
      color: white;
    }
    .toolbar-btn.primary:hover {
      background: #4f46e5;
    }
    .toolbar-btn.danger {
      background: #fee;
      border-color: #fcc;
      color: #c33;
    }
    .toolbar-btn.danger:hover {
      background: #fcc;
    }
    .toolbar-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    /* 导出下拉菜单 */
    .export-dropdown {
      position: relative;
    }
    .export-menu {
      display: none;
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow-lg);
      min-width: 160px;
      z-index: 100;
    }
    .export-dropdown:hover .export-menu {
      display: block;
    }
    .export-menu button {
      display: block;
      width: 100%;
      padding: 10px 16px;
      border: none;
      background: transparent;
      color: var(--text);
      text-align: left;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .export-menu button:hover {
      background: var(--bg);
    }
    .export-menu button:first-child {
      border-radius: 8px 8px 0 0;
    }
    .export-menu button:last-child {
      border-radius: 0 0 8px 8px;
    }
    
    /* 高级筛选面板 */
    .advanced-filter {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .filter-label {
      font-size: 14px;
      color: var(--text-secondary);
      white-space: nowrap;
      min-width: 80px;
    }
    .filter-select, .filter-input {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      transition: all 0.2s;
    }
    .filter-select {
      min-width: 150px;
      cursor: pointer;
    }
    .filter-input {
      flex: 1;
      min-width: 140px;
    }
    .filter-select:hover, .filter-input:hover {
      border-color: var(--primary);
    }
    .filter-select:focus, .filter-input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }
    .filter-separator {
      color: var(--text-secondary);
      font-size: 14px;
    }
    .filter-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 20px;
    }
    .filter-btn {
      padding: 8px 20px;
      border: 1px solid var(--primary);
      border-radius: 8px;
      background: var(--primary);
      color: white;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .filter-btn:hover {
      background: #4f46e5;
    }
    .filter-btn.secondary {
      background: transparent;
      color: var(--primary);
    }
    .filter-btn.secondary:hover {
      background: rgba(99, 102, 241, 0.1);
    }
    
    /* 批量选择样式 */
    .item-card.batch-mode {
      position: relative;
      padding-left: 50px;
    }
    .batch-checkbox {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      cursor: pointer;
    }
    .item-card.selected {
      background: rgba(99, 102, 241, 0.05);
      border-color: var(--primary);
    }
    
    /* 导入预览样式 */
    .import-preview {
      margin-top: 20px;
      padding: 20px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .import-preview p {
      margin-bottom: 12px;
      color: var(--text);
    }
    .import-list {
      list-style: none;
      padding: 0;
      max-height: 300px;
      overflow-y: auto;
      margin-bottom: 20px;
    }
    .import-list li {
      padding: 12px;
      border-bottom: 1px solid var(--border);
    }
    .import-list li:last-child {
      border-bottom: none;
    }
    .import-tags {
      color: var(--primary);
      font-size: 13px;
      margin-bottom: 6px;
    }
    .import-content {
      color: var(--text-secondary);
      font-size: 14px;
    }
    
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
      
      /* 移动端紧凑型工具栏 */
      .compact-toolbar {
        flex-direction: column;
        align-items: stretch;
        padding: 10px 12px;
      }
      .toolbar-group {
        width: 100%;
        justify-content: space-between;
      }
      .group-label {
        font-size: 12px;
      }
      .compact-btn {
        font-size: 12px;
        padding: 5px 10px;
      }
      .compact-select {
        font-size: 12px;
        padding: 5px 8px;
        flex: 1;
      }
      .compact-dropdown {
        flex: 1;
      }
      .compact-menu {
        left: 0;
        right: 0;
        width: 100%;
      }
      
      /* 移动端抽屉 */
      .filter-drawer-content {
        max-width: 100%;
        width: 90%;
      }
      .filter-drawer-header {
        padding: 16px;
      }
      .filter-drawer-header h3 {
        font-size: 16px;
      }
      .filter-drawer-body {
        padding: 16px;
      }
      .filter-date-group {
        flex-direction: column;
        align-items: stretch;
      }
      .filter-date-sep {
        text-align: center;
        margin: 4px 0;
      }
      .filter-drawer-footer {
        padding: 12px 16px;
      }
      .filter-drawer-btn {
        padding: 10px;
        font-size: 13px;
      }
      
      /* 移动端工具栏（旧版） */
      .toolbar {
        flex-direction: column;
        align-items: stretch;
      }
      .toolbar-left, .toolbar-right {
        width: 100%;
        justify-content: center;
      }
      .toolbar-btn {
        flex: 1;
        text-align: center;
      }
      .export-dropdown {
        width: 100%;
      }
      .export-menu {
        width: 100%;
      }
      
      /* 移动端筛选（旧版） */
      .filter-row {
        flex-direction: column;
        align-items: stretch;
      }
      .filter-label {
        min-width: auto;
      }
      .filter-select, .filter-input {
        width: 100%;
      }
      .filter-actions {
        flex-direction: column;
      }
      .filter-btn {
        width: 100%;
      }
      
      /* 移动端分页和控件 */
      .list-controls { 
        flex-direction: column; 
        align-items: stretch;
        gap: 12px;
      }
      .sort-controls, .page-size-controls {
        justify-content: space-between;
      }
      .items-count {
        text-align: center;
        margin-left: 0;
      }
      .pagination {
        gap: 4px;
      }
      .page-btn {
        min-width: 36px;
        height: 36px;
        padding: 0 8px;
        font-size: 13px;
      }
    }
    @media (max-width: 480px) {
      .logo span { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
      .control-label, .filter-label {
        font-size: 13px;
      }
      .control-select, .filter-select {
        font-size: 13px;
      }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="toast" class="toast"></div>
  <div id="loading" class="loading-overlay"><div class="loading-spinner"></div></div>

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
      footerItems: [],
      // 分页和排序
      currentPage: 1,
      itemsPerPage: parseInt(localStorage.getItem('itemsPerPage')) || 20,
      sortBy: localStorage.getItem('sortBy') || 'time-desc',
      // 批量操作
      batchMode: false,
      selectedIds: [],
      // 高级筛选
      advancedFilter: {
        mediaType: '',     // photo, audio, video, document, none
        dateFrom: '',
        dateTo: ''
      }
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
    
    // ========== 自定义音频播放器控制 ==========
    
    // 初始化 Plyr 播放器（统一处理音频和视频）
    function initPlayers() {
      // 初始化音频播放器
      document.querySelectorAll('.plyr-audio').forEach(function(audioEl) {
        if (audioEl.plyr) return; // 已初始化
        
        try {
          new Plyr(audioEl, {
            controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume'],
            settings: [],
            displayDuration: true,
            invertTime: false
          });
        } catch (e) {
          console.error('Plyr audio init error:', e);
        }
      });
      
      // 初始化视频播放器
      document.querySelectorAll('.plyr-video').forEach(function(videoEl) {
        if (videoEl.plyr) return; // 已初始化
        
        try {
          new Plyr(videoEl, {
            controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'fullscreen'],
            settings: ['quality', 'speed'],
            speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
            ratio: '16:9',
            displayDuration: true,
            invertTime: false
          });
        } catch (e) {
          console.error('Plyr video init error:', e);
        }
      });
    }
    
    // 图片懒加载
    function initLazyLoad() {
      var lazyImages = document.querySelectorAll('.lazy-image');
      
      if ('IntersectionObserver' in window) {
        var imageObserver = new IntersectionObserver(function(entries) {
          entries.forEach(function(entry) {
            if (entry.isIntersecting) {
              var img = entry.target;
              img.src = img.dataset.src;
              img.classList.remove('lazy-image');
              img.classList.add('lazy-loaded');
              imageObserver.unobserve(img);
            }
          });
        }, {
          rootMargin: '50px 0px'  // 提前 50px 开始加载
        });
        
        lazyImages.forEach(function(img) {
          imageObserver.observe(img);
        });
      } else {
        // 不支持 IntersectionObserver，直接加载所有图片
        lazyImages.forEach(function(img) {
          img.src = img.dataset.src;
          img.classList.remove('lazy-image');
        });
      }
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
      state.currentPage = 1;
      history.pushState({}, '', tag ? '/?tag=' + encodeURIComponent(tag) : '/');
      render();
    }
    
    function filterBySource(source) {
      state.currentSource = source;
      state.currentTag = '';
      state.currentQ = '';
      state.currentPage = 1;
      history.pushState({}, '', '/?source=' + encodeURIComponent(source));
      render();
    }
    
    function searchItems(q) {
      state.currentQ = q;
      state.currentTag = '';
      state.currentSource = '';
      state.currentPage = 1;
      history.pushState({}, '', q ? '/?q=' + encodeURIComponent(q) : '/');
      render();
    }
    
    function clearFilters() {
      state.currentTag = '';
      state.currentSource = '';
      state.currentQ = '';
      state.currentPage = 1;
      history.pushState({}, '', '/');
      render();
    }
    
    // ========== 分页和排序控制 ==========
    function goToPage(page) {
      state.currentPage = page;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      render();
    }
    
    function changeSortBy(sortBy) {
      state.sortBy = sortBy;
      state.currentPage = 1;
      localStorage.setItem('sortBy', sortBy);
      render();
    }
    
    function changePageSize(size) {
      state.itemsPerPage = size === 'all' ? 'all' : parseInt(size);
      state.currentPage = 1;
      localStorage.setItem('itemsPerPage', size);
      render();
    }
    
    // ========== 批量操作功能 ==========
    function enterBatchMode() {
      state.batchMode = true;
      state.selectedIds = [];
      render();
    }
    
    function exitBatchMode() {
      state.batchMode = false;
      state.selectedIds = [];
      render();
    }
    
    function toggleItemSelection(id) {
      var index = state.selectedIds.indexOf(id);
      if (index > -1) {
        state.selectedIds.splice(index, 1);
      } else {
        state.selectedIds.push(id);
      }
      
      // 只更新 DOM，避免整页重新渲染导致闪烁
      var card = document.getElementById('item-' + id);
      if (card) {
        if (state.selectedIds.indexOf(id) > -1) {
          card.classList.add('selected');
        } else {
          card.classList.remove('selected');
        }
      }
      
      // 只更新删除按钮的状态
      updateBatchDeleteButton();
    }
    
    function updateBatchDeleteButton() {
      // 更新旧样式删除按钮
      var deleteBtn = document.querySelector('.toolbar-btn.danger');
      if (deleteBtn) {
        deleteBtn.disabled = state.selectedIds.length === 0;
        deleteBtn.textContent = '🗑️ 删除(' + state.selectedIds.length + ')';
      }
      
      // 更新紧凑型工具栏删除按钮
      var compactDeleteBtn = document.querySelector('.compact-btn.danger');
      if (compactDeleteBtn) {
        compactDeleteBtn.disabled = state.selectedIds.length === 0;
        compactDeleteBtn.innerHTML = '🗑️(' + state.selectedIds.length + ')';
      }
    }
    
    function selectAllItems() {
      var allItems = getFilteredItems();
      var paginatedItems = getPaginatedItems(allItems);
      state.selectedIds = paginatedItems.map(function(item) { return item.id; });
      render();
    }
    
    function deselectAllItems() {
      state.selectedIds = [];
      render();
    }
    
    function batchDelete() {
      if (state.selectedIds.length === 0) return;
      
      if (!confirm('确定要删除选中的 ' + state.selectedIds.length + ' 条收藏吗？')) {
        return;
      }
      
      showLoading();
      var promises = state.selectedIds.map(function(id) {
        return apiCall('POST', '/api/delete/' + id);
      });
      
      Promise.all(promises).then(function() {
        showToast('批量删除成功');
        state.selectedIds = [];
        state.batchMode = false;
        loadData().then(function() {
          hideLoading();
          render();
        });
      }).catch(function(err) {
        hideLoading();
        showToast('批量删除失败');
      });
    }
    
    // ========== 导出功能 ==========
    function exportAs(format) {
      var allItems = getFilteredItems();
      var filename = 'navcollect_export_' + new Date().toISOString().split('T')[0];
      
      if (format === 'json') {
        exportAsJSON(allItems, filename);
      } else if (format === 'markdown') {
        exportAsMarkdown(allItems, filename);
      } else if (format === 'html') {
        exportAsHTML(allItems, filename);
      }
    }
    
    function exportAsJSON(items, filename) {
      var data = {
        exportDate: new Date().toISOString(),
        totalCount: items.length,
        siteConfig: state.siteConfig,
        items: items
      };
      
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      downloadFile(blob, filename + '.json');
      showToast('导出 JSON 成功');
    }
    
    function exportAsMarkdown(items, filename) {
      var md = '# ' + state.siteConfig.title + ' 导出\\n\\n';
      md += '导出时间: ' + new Date().toLocaleString('zh-CN') + '\\n\\n';
      md += '总计: ' + items.length + ' 条收藏\\n\\n';
      md += '---\\n\\n';
      
      items.forEach(function(item) {
        md += '## ' + (item.content.split('\\n')[0] || '收藏') + '\\n\\n';
        
        if (item.tags && item.tags.length > 0) {
          md += '**标签**: ' + item.tags.map(function(t) { return '#' + t; }).join(' ') + '\\n\\n';
        }
        
        md += item.content + '\\n\\n';
        
        if (item.media) {
          md += '**媒体**: ' + item.media.type;
          if (item.media.fileName) {
            md += ' - ' + item.media.fileName;
          }
          md += '\\n\\n';
        }
        
        if (item.source_info) {
          md += '**来源**: ';
          if (item.source_info.username) {
            md += '@' + item.source_info.username;
          } else if (item.source_info.channel_title) {
            md += item.source_info.channel_title;
          } else if (item.source_info.first_name) {
            md += item.source_info.first_name;
          }
          md += '\\n\\n';
        }
        
        md += '**时间**: ' + new Date(item.timestamp).toLocaleString('zh-CN') + '\\n\\n';
        md += '---\\n\\n';
      });
      
      var blob = new Blob([md], { type: 'text/markdown' });
      downloadFile(blob, filename + '.md');
      showToast('导出 Markdown 成功');
    }
    
    function exportAsHTML(items, filename) {
      var html = '<!DOCTYPE html>\\n<html lang="zh-CN">\\n<head>\\n';
      html += '<meta charset="UTF-8">\\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\\n';
      html += '<title>' + escapeHtml(state.siteConfig.title) + ' - 导出</title>\\n<style>\\n';
      html += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:800px;margin:40px auto;padding:20px;background:#f5f5f5}';
      html += '.item{background:white;padding:20px;margin-bottom:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}';
      html += '.tags{margin-bottom:10px}.tag{display:inline-block;background:#e3f2fd;color:#1976d2;padding:4px 12px;border-radius:12px;margin-right:8px;font-size:14px}';
      html += '.content{line-height:1.6;margin-bottom:10px}.meta{color:#666;font-size:14px}h1{color:#333}';
      html += '.export-info{background:#fff3cd;padding:15px;border-radius:8px;margin-bottom:20px}';
      html += '</style>\\n</head>\\n<body>\\n';
      
      html += '<h1>' + escapeHtml(state.siteConfig.title) + ' - 导出</h1>\\n';
      html += '<div class="export-info"><p><strong>导出时间:</strong> ' + new Date().toLocaleString('zh-CN') + '</p>';
      html += '<p><strong>总计:</strong> ' + items.length + ' 条收藏</p></div>\\n';
      
      items.forEach(function(item) {
        html += '<div class="item">\\n';
        if (item.tags && item.tags.length > 0) {
          html += '<div class="tags">';
          item.tags.forEach(function(tag) {
            html += '<span class="tag">#' + escapeHtml(tag) + '</span>';
          });
          html += '</div>\\n';
        }
        html += '<div class="content">' + escapeHtml(item.content).replace(/\\n/g, '<br>') + '</div>\\n';
        html += '<div class="meta">';
        if (item.source_info) {
          html += '<span>📥 ';
          if (item.source_info.username) {
            html += '@' + escapeHtml(item.source_info.username);
          } else if (item.source_info.channel_title) {
            html += escapeHtml(item.source_info.channel_title);
          }
          html += '</span> | ';
        }
        html += '<span>🕐 ' + new Date(item.timestamp).toLocaleString('zh-CN') + '</span></div>\\n';
        html += '</div>\\n';
      });
      
      html += '</body>\\n</html>';
      
      var blob = new Blob([html], { type: 'text/html' });
      downloadFile(blob, filename + '.html');
      showToast('导出 HTML 成功');
    }
    
    function downloadFile(blob, filename) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    
    // ========== 导入功能 ==========
    function showImportModal() {
      document.getElementById('import-modal').style.display = 'flex';
    }
    
    function hideImportModal() {
      document.getElementById('import-modal').style.display = 'none';
      document.getElementById('import-file').value = '';
      document.getElementById('import-preview').innerHTML = '';
    }
    
    function handleImportFile(event) {
      var file = event.target.files[0];
      if (!file) return;
      
      if (file.type !== 'application/json') {
        showToast('请选择 JSON 文件');
        return;
      }
      
      var reader = new FileReader();
      reader.onload = function(e) {
        try {
          var data = JSON.parse(e.target.result);
          previewImportData(data);
        } catch (err) {
          showToast('JSON 格式错误');
        }
      };
      reader.readAsText(file);
    }
    
    function previewImportData(data) {
      if (!data.items || !Array.isArray(data.items)) {
        showToast('无效的导出文件');
        return;
      }
      
      var preview = '<div class="import-preview">';
      preview += '<p><strong>导出时间:</strong> ' + (data.exportDate || '未知') + '</p>';
      preview += '<p><strong>总计:</strong> ' + data.items.length + ' 条</p>';
      preview += '<p><strong>预览:</strong></p>';
      preview += '<ul class="import-list">';
      
      data.items.slice(0, 5).forEach(function(item) {
        preview += '<li>';
        preview += '<div class="import-tags">' + (item.tags || []).map(function(t) { return '#' + t; }).join(' ') + '</div>';
        preview += '<div class="import-content">' + (item.content || '').substring(0, 100) + '...</div>';
        preview += '</li>';
      });
      
      if (data.items.length > 5) {
        preview += '<li>... 还有 ' + (data.items.length - 5) + ' 条</li>';
      }
      
      preview += '</ul>';
      preview += '<button class="btn btn-primary" onclick="confirmImport()">确认导入</button>';
      preview += '<button class="btn btn-secondary" onclick="hideImportModal()">取消</button>';
      preview += '</div>';
      
      document.getElementById('import-preview').innerHTML = preview;
      
      // 保存到临时状态
      state.importData = data;
    }
    
    function confirmImport() {
      if (!state.importData) return;
      
      showLoading();
      
      var items = state.importData.items;
      var promises = items.map(function(item) {
        return apiCall('POST', '/api/add', {
          content: item.content || '',
          tags: item.tags || [],
          source: item.source || 'import',
          media: item.media || null
        });
      });
      
      Promise.all(promises).then(function() {
        showToast('导入成功: ' + items.length + ' 条');
        state.importData = null;
        hideImportModal();
        loadData().then(function() {
          hideLoading();
          render();
        });
      }).catch(function(err) {
        hideLoading();
        showToast('导入失败');
      });
    }
    
    // ========== 高级筛选功能 ==========
    // ========== 抽屉式筛选控制 ==========
    function toggleFilterDrawer() {
      state.showAdvancedFilter = !state.showAdvancedFilter;
      
      // 只更新抽屉的 class，不重新渲染整个页面
      var drawer = document.querySelector('.filter-drawer');
      if (drawer) {
        if (state.showAdvancedFilter) {
          drawer.classList.add('open');
          // 防止背景滚动
          document.body.style.overflow = 'hidden';
        } else {
          drawer.classList.remove('open');
          document.body.style.overflow = '';
        }
      }
    }
    
    function applyFilterDrawer() {
      state.currentPage = 1;
      state.showAdvancedFilter = false;
      document.body.style.overflow = '';
      render();
    }
    
    function clearFilterDrawer() {
      state.advancedFilter = {
        mediaType: '',
        dateFrom: '',
        dateTo: ''
      };
      state.currentPage = 1;
      state.showAdvancedFilter = false;
      document.body.style.overflow = '';
      render();
    }
    
    function setDateShortcut(type) {
      var today = new Date();
      var year = today.getFullYear();
      var month = String(today.getMonth() + 1).padStart(2, '0');
      var day = String(today.getDate()).padStart(2, '0');
      
      if (type === 'today') {
        state.advancedFilter.dateFrom = year + '-' + month + '-' + day;
        state.advancedFilter.dateTo = year + '-' + month + '-' + day;
      } else if (type === 'week') {
        var weekAgo = new Date(today);
        weekAgo.setDate(today.getDate() - 7);
        var wYear = weekAgo.getFullYear();
        var wMonth = String(weekAgo.getMonth() + 1).padStart(2, '0');
        var wDay = String(weekAgo.getDate()).padStart(2, '0');
        state.advancedFilter.dateFrom = wYear + '-' + wMonth + '-' + wDay;
        state.advancedFilter.dateTo = year + '-' + month + '-' + day;
      } else if (type === 'month') {
        var monthAgo = new Date(today);
        monthAgo.setMonth(today.getMonth() - 1);
        var mYear = monthAgo.getFullYear();
        var mMonth = String(monthAgo.getMonth() + 1).padStart(2, '0');
        var mDay = String(monthAgo.getDate()).padStart(2, '0');
        state.advancedFilter.dateFrom = mYear + '-' + mMonth + '-' + mDay;
        state.advancedFilter.dateTo = year + '-' + month + '-' + day;
      }
      render();
    }
    
    function toggleAdvancedFilter() {
      state.showAdvancedFilter = !state.showAdvancedFilter;
      render();
    }
    
    function setMediaTypeFilter(type) {
      state.advancedFilter.mediaType = type;
    }
    
    function setDateFromFilter(date) {
      state.advancedFilter.dateFrom = date;
    }
    
    function setDateToFilter(date) {
      state.advancedFilter.dateTo = date;
    }
    
    function applyAdvancedFilter() {
      state.currentPage = 1;
      render();
    }
    
    function clearAdvancedFilter() {
      state.advancedFilter = {
        mediaType: '',
        dateFrom: '',
        dateTo: ''
      };
      state.currentPage = 1;
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
          if (data.botConfigured !== undefined) {
            state.botConfigured = data.botConfigured;
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
      
      // 基本筛选
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
      
      // 高级筛选 - 媒体类型
      if (state.advancedFilter && state.advancedFilter.mediaType) {
        if (state.advancedFilter.mediaType === 'none') {
          items = items.filter(function(item) { return !item.media; });
        } else {
          items = items.filter(function(item) { 
            return item.media && item.media.type === state.advancedFilter.mediaType; 
          });
        }
      }
      
      // 高级筛选 - 日期范围
      if (state.advancedFilter && state.advancedFilter.dateFrom) {
        var fromDate = new Date(state.advancedFilter.dateFrom);
        items = items.filter(function(item) {
          return new Date(item.timestamp) >= fromDate;
        });
      }
      if (state.advancedFilter && state.advancedFilter.dateTo) {
        var toDate = new Date(state.advancedFilter.dateTo);
        toDate.setHours(23, 59, 59, 999);
        items = items.filter(function(item) {
          return new Date(item.timestamp) <= toDate;
        });
      }
      
      // 排序
      items = sortItems(items, state.sortBy);
      
      return items;
    }
    
    function sortItems(items, sortBy) {
      var sorted = items.slice(); // 复制数组
      
      if (sortBy === 'time-desc') {
        sorted.sort(function(a, b) {
          return new Date(b.timestamp) - new Date(a.timestamp);
        });
      } else if (sortBy === 'time-asc') {
        sorted.sort(function(a, b) {
          return new Date(a.timestamp) - new Date(b.timestamp);
        });
      } else if (sortBy === 'tags-desc') {
        sorted.sort(function(a, b) {
          return b.tags.length - a.tags.length;
        });
      } else if (sortBy === 'tags-asc') {
        sorted.sort(function(a, b) {
          return a.tags.length - b.tags.length;
        });
      }
      
      return sorted;
    }
    
    function getPaginatedItems(items) {
      if (state.itemsPerPage === 'all') {
        return items;
      }
      
      var start = (state.currentPage - 1) * state.itemsPerPage;
      var end = start + state.itemsPerPage;
      return items.slice(start, end);
    }
    
    function getTotalPages(items) {
      if (state.itemsPerPage === 'all') return 1;
      return Math.ceil(items.length / state.itemsPerPage);
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
      
      // 渲染媒体内容
      var mediaHtml = '';
      if (item.media) {
        mediaHtml = renderMedia(item.media);
      }
      
      // 只在有内容时才显示内容区域
      var contentHtml = item.content && item.content.trim() 
        ? '<div class="item-content">' + formatContent(item.content) + '</div>'
        : '';
      
      // 批量选择模式的复选框
      var checkboxHtml = '';
      var cardClasses = 'item-card';
      if (state.batchMode) {
        cardClasses += ' batch-mode';
        var isSelected = state.selectedIds.indexOf(item.id) > -1;
        if (isSelected) cardClasses += ' selected';
        checkboxHtml = '<input type="checkbox" class="batch-checkbox" ' + 
          (isSelected ? 'checked' : '') + 
          ' onchange="toggleItemSelection(\\'' + item.id + '\\')">';
      }
      
      // 标签区域 - 独立显示，标题和操作在同一行
      var tagsSection = '';
      if (tags) {
        tagsSection = '<div class="item-tags-section">' +
          '<div class="tags-header">' +
          '<span class="tags-label">🏷️ 标签</span>' +
          actions +
          '</div>' +
          '<div class="item-tags">' + tags + '</div>' +
          '</div>';
      }
      
      return '<div class="' + cardClasses + '" id="item-' + item.id + '">' +
        checkboxHtml +
        tagsSection +
        mediaHtml +
        contentHtml +
        '<div class="item-meta"><span>📥 ' + sourceHtml + '</span><span>🕐 ' + formatTime(item.timestamp) + '</span>' + editedBadge + '</div>' +
        '</div>';
    }
    
    // 渲染媒体文件
    function renderMedia(media) {
      if (!media) return '';
      
      // 如果是数组（媒体组），分别处理图片和视频
      if (Array.isArray(media)) {
        var photos = media.filter(function(m) { return m.type === 'photo'; });
        var videos = media.filter(function(m) { return m.type === 'video'; });
        var others = media.filter(function(m) { return m.type !== 'photo' && m.type !== 'video'; });
        
        var html = '<div class="media-container media-group">';
        
        // 渲染图片轮播（如果有）
        if (photos.length > 0) {
          html += renderPhotoCarousel(photos);
        }
        
        // 渲染视频网格（如果有）
        if (videos.length > 0) {
          html += renderVideoGrid(videos);
        }
        
        // 渲染其他媒体
        for (var i = 0; i < others.length; i++) {
          html += renderSingleMedia(others[i]);
        }
        
        html += '</div>';
        return html;
      }
      
      // 单个媒体
      return '<div class="media-container">' + renderSingleMedia(media) + '</div>';
    }
    
    // 渲染图片轮播
    function renderPhotoCarousel(photos) {
      if (photos.length === 0) return '';
      
      var carouselId = 'carousel-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      var html = '<div class="photo-carousel" id="' + carouselId + '">';
      html += '<div class="carousel-track">';
      
      for (var i = 0; i < photos.length; i++) {
        var photo = photos[i];
        var imgSrc = '/api/file/' + photo.fileId;
        html += '<div class="carousel-slide' + (i === 0 ? ' active' : '') + '">';
        html += '<img data-src="' + imgSrc + '" alt="图片' + (i + 1) + '" class="carousel-image lazy-image" onclick="openImageViewer(\\'' + carouselId + '\\', ' + i + ')">';
        html += '</div>';
      }
      
      html += '</div>';
      
      // 添加导航按钮（多于1张图时）
      if (photos.length > 1) {
        html += '<button class="carousel-btn carousel-prev" onclick="carouselPrev(\\'' + carouselId + '\\')">‹</button>';
        html += '<button class="carousel-btn carousel-next" onclick="carouselNext(\\'' + carouselId + '\\')">›</button>';
        html += '<div class="carousel-indicators">';
        for (var i = 0; i < photos.length; i++) {
          html += '<span class="carousel-indicator' + (i === 0 ? ' active' : '') + '" onclick="carouselGoto(\\'' + carouselId + '\\', ' + i + ')"></span>';
        }
        html += '</div>';
      }
      
      html += '</div>';
      return html;
    }
    
    // 渲染视频网格
    function renderVideoGrid(videos) {
      if (videos.length === 0) return '';
      
      // 根据视频数量决定列数：1个=1列，2个=2列，3+个=3列
      var cols = videos.length === 1 ? 1 : videos.length === 2 ? 2 : 3;
      var html = '<div class="video-grid video-grid-' + cols + 'col">';
      
      for (var i = 0; i < videos.length; i++) {
        var video = videos[i];
        if (video.fileSize < 20 * 1024 * 1024 && video.fileId) {
          var videoId = 'video-' + Date.now() + '-' + i + '-' + Math.random().toString(36).substr(2, 9);
          html += '<div class="video-grid-item">';
          html += '<video id="' + videoId + '" class="plyr-video" controls playsinline>';
          html += '<source src="/api/file/' + video.fileId + '" type="' + (video.mimeType || 'video/mp4') + '">';
          html += '</video>';
          html += '</div>';
        } else {
          html += '<div class="video-grid-item media-file">';
          html += '<a href="' + video.telegramLink + '" target="_blank" class="media-link">';
          html += '🎬 视频' + (i + 1) + ' (' + formatFileSize(video.fileSize) + ')';
          html += '</a>';
          html += '</div>';
        }
      }
      
      html += '</div>';
      return html;
    }
    
    // 渲染单个媒体
    function renderSingleMedia(media) {
      var html = '';
      
      if (media.type === 'photo') {
        // 图片：使用代理，不再用 base64
        var imgSrc = '/api/file/' + media.fileId;
        html += '<img data-src="' + imgSrc + '" alt="图片" class="media-image lazy-image" onclick="openSingleImageViewer(this.src)">';
      } else if (media.type === 'sticker') {
        // 贴纸：支持静态和动态贴纸
        var stickerSrc = '/api/file/' + media.fileId;
        html += '<div class="media-sticker">';
        if (media.isVideo) {
          // 视频贴纸（.webm）
          html += '<video class="sticker-image" autoplay loop muted playsinline>';
          html += '<source src="' + stickerSrc + '" type="video/webm">';
          html += '</video>';
        } else if (media.isAnimated) {
          // 动画贴纸（.tgs）- 使用图片展示或链接
          html += '<img data-src="' + stickerSrc + '" alt="贴纸" class="sticker-image lazy-image">';
        } else {
          // 静态贴纸（.webp）
          html += '<img data-src="' + stickerSrc + '" alt="贴纸" class="sticker-image lazy-image">';
        }
        // 不显示 emoji，这是 Telegram 的元数据，不需要在前端展示
        html += '</div>';
      } else if (media.type === 'audio' || media.type === 'voice') {
        // 音频/语音
        if (media.fileSize < 20 * 1024 * 1024 && media.fileId) {
          var audioId = 'audio-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
          html += '<div class="media-audio">';
          html += '<audio id="' + audioId + '" class="plyr-audio" controls>';
          html += '<source src="/api/file/' + media.fileId + '" type="' + (media.mimeType || 'audio/mpeg') + '">';
          html += '</audio>';
          if (media.fileName) {
            html += '<div class="media-filename">' + (media.type === 'voice' ? '🎤' : '🎵') + ' ' + escapeHtml(media.fileName) + '</div>';
          }
          html += '</div>';
        } else {
          html += '<div class="media-file">';
          html += '<a href="' + media.telegramLink + '" target="_blank" class="media-link">';
          html += (media.type === 'voice' ? '🎤' : '🎵') + ' ' + escapeHtml(media.fileName || 'audio') + ' (' + formatFileSize(media.fileSize) + ')';
          html += '</a>';
          html += '</div>';
        }
      } else if (media.type === 'video') {
        // 单个视频
        if (media.fileSize < 20 * 1024 * 1024 && media.fileId) {
          var videoId = 'video-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
          html += '<div class="media-video">';
          html += '<video id="' + videoId + '" class="plyr-video" controls playsinline>';
          html += '<source src="/api/file/' + media.fileId + '" type="' + (media.mimeType || 'video/mp4') + '">';
          html += '</video>';
          if (media.fileName) {
            html += '<div class="media-filename">🎬 ' + escapeHtml(media.fileName) + ' (' + formatFileSize(media.fileSize) + ')</div>';
          }
          html += '</div>';
        } else {
          html += '<div class="media-file">';
          html += '<a href="' + media.telegramLink + '" target="_blank" class="media-link">';
          html += '🎬 ' + escapeHtml(media.fileName || 'video') + ' (' + formatFileSize(media.fileSize) + ')';
          html += '</a>';
          html += '</div>';
        }
      } else if (media.type === 'document') {
        // 文档
        html += '<div class="media-file">';
        if (media.fileSize < 20 * 1024 * 1024 && media.fileId) {
          html += '<a href="/api/file/' + media.fileId + '" target="_blank" class="media-link" download>';
          html += '📎 ' + escapeHtml(media.fileName || 'document') + ' (' + formatFileSize(media.fileSize) + ')';
          html += '</a>';
        } else {
          html += '<a href="' + media.telegramLink + '" target="_blank" class="media-link">';
          html += '📎 ' + escapeHtml(media.fileName || 'document') + ' (' + formatFileSize(media.fileSize) + ')';
          html += '</a>';
        }
        html += '</div>';
      }
      
      return html;
    }

    
    // 格式化文件大小
    function formatFileSize(bytes) {
      if (!bytes) return '0 B';
      var k = 1024;
      var sizes = ['B', 'KB', 'MB', 'GB'];
      var i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }
    
    // ========== 轮播相关函数 ==========
    function carouselNext(carouselId) {
      var carousel = document.getElementById(carouselId);
      if (!carousel) return;
      
      var slides = carousel.querySelectorAll('.carousel-slide');
      var indicators = carousel.querySelectorAll('.carousel-indicator');
      var currentIndex = -1;
      
      for (var i = 0; i < slides.length; i++) {
        if (slides[i].classList.contains('active')) {
          currentIndex = i;
          break;
        }
      }
      
      var nextIndex = (currentIndex + 1) % slides.length;
      slides[currentIndex].classList.remove('active');
      slides[nextIndex].classList.add('active');
      indicators[currentIndex].classList.remove('active');
      indicators[nextIndex].classList.add('active');
    }
    
    function carouselPrev(carouselId) {
      var carousel = document.getElementById(carouselId);
      if (!carousel) return;
      
      var slides = carousel.querySelectorAll('.carousel-slide');
      var indicators = carousel.querySelectorAll('.carousel-indicator');
      var currentIndex = -1;
      
      for (var i = 0; i < slides.length; i++) {
        if (slides[i].classList.contains('active')) {
          currentIndex = i;
          break;
        }
      }
      
      var prevIndex = (currentIndex - 1 + slides.length) % slides.length;
      slides[currentIndex].classList.remove('active');
      slides[prevIndex].classList.add('active');
      indicators[currentIndex].classList.remove('active');
      indicators[prevIndex].classList.add('active');
    }
    
    function carouselGoto(carouselId, index) {
      var carousel = document.getElementById(carouselId);
      if (!carousel) return;
      
      var slides = carousel.querySelectorAll('.carousel-slide');
      var indicators = carousel.querySelectorAll('.carousel-indicator');
      
      for (var i = 0; i < slides.length; i++) {
        slides[i].classList.remove('active');
        indicators[i].classList.remove('active');
      }
      
      slides[index].classList.add('active');
      indicators[index].classList.add('active');
    }
    
    function openImageViewer(carouselId, index) {
      var carousel = document.getElementById(carouselId);
      if (!carousel) return;
      
      var slides = carousel.querySelectorAll('.carousel-slide');
      var images = [];
      
      // 收集所有图片
      for (var i = 0; i < slides.length; i++) {
        var img = slides[i].querySelector('img');
        if (img) {
          images.push(img.src || img.getAttribute('data-src'));
        }
      }
      
      if (images.length === 0) return;
      
      // 创建预览弹窗
      var overlay = document.createElement('div');
      overlay.className = 'image-viewer-overlay';
      overlay.onclick = function(e) {
        if (e.target === overlay) {
          closeImageViewer();
        }
      };
      
      var content = document.createElement('div');
      content.className = 'image-viewer-content';
      
      var img = document.createElement('img');
      img.className = 'image-viewer-img';
      img.src = images[index];
      content.appendChild(img);
      
      // 关闭按钮
      var closeBtn = document.createElement('button');
      closeBtn.className = 'image-viewer-close';
      closeBtn.innerHTML = '×';
      closeBtn.onclick = closeImageViewer;
      overlay.appendChild(closeBtn);
      
      // 如果有多张图片，添加导航按钮
      if (images.length > 1) {
        var currentIndex = index;
        
        // 上一张按钮
        var prevBtn = document.createElement('button');
        prevBtn.className = 'image-viewer-nav prev';
        prevBtn.innerHTML = '‹';
        prevBtn.onclick = function() {
          currentIndex = (currentIndex - 1 + images.length) % images.length;
          img.src = images[currentIndex];
          updateCounter();
        };
        overlay.appendChild(prevBtn);
        
        // 下一张按钮
        var nextBtn = document.createElement('button');
        nextBtn.className = 'image-viewer-nav next';
        nextBtn.innerHTML = '›';
        nextBtn.onclick = function() {
          currentIndex = (currentIndex + 1) % images.length;
          img.src = images[currentIndex];
          updateCounter();
        };
        overlay.appendChild(nextBtn);
        
        // 计数器
        var counter = document.createElement('div');
        counter.className = 'image-viewer-counter';
        overlay.appendChild(counter);
        
        function updateCounter() {
          counter.textContent = (currentIndex + 1) + ' / ' + images.length;
        }
        updateCounter();
        
        // 键盘导航
        document.addEventListener('keydown', handleKeyPress);
        function handleKeyPress(e) {
          if (e.key === 'ArrowLeft') {
            prevBtn.click();
          } else if (e.key === 'ArrowRight') {
            nextBtn.click();
          } else if (e.key === 'Escape') {
            closeImageViewer();
          }
        }
        
        overlay._handleKeyPress = handleKeyPress;
      }
      
      overlay.appendChild(content);
      document.body.appendChild(overlay);
      
      function closeImageViewer() {
        if (overlay._handleKeyPress) {
          document.removeEventListener('keydown', overlay._handleKeyPress);
        }
        overlay.remove();
      }
    }
    
    // 单张图片预览
    function openSingleImageViewer(imageSrc) {
      if (!imageSrc) return;
      
      // 创建预览弹窗
      var overlay = document.createElement('div');
      overlay.className = 'image-viewer-overlay';
      overlay.onclick = function(e) {
        if (e.target === overlay) {
          closeViewer();
        }
      };
      
      var content = document.createElement('div');
      content.className = 'image-viewer-content';
      
      var img = document.createElement('img');
      img.className = 'image-viewer-img';
      img.src = imageSrc;
      content.appendChild(img);
      
      // 关闭按钮
      var closeBtn = document.createElement('button');
      closeBtn.className = 'image-viewer-close';
      closeBtn.innerHTML = '×';
      closeBtn.onclick = closeViewer;
      overlay.appendChild(closeBtn);
      
      // 键盘 ESC 关闭
      function handleKeyPress(e) {
        if (e.key === 'Escape') {
          closeViewer();
        }
      }
      document.addEventListener('keydown', handleKeyPress);
      
      overlay.appendChild(content);
      document.body.appendChild(overlay);
      
      function closeViewer() {
        document.removeEventListener('keydown', handleKeyPress);
        overlay.remove();
      }
    }

    
    function renderItemsList(isAdmin) {
      var allItems = getFilteredItems();
      
      var paginatedItems = allItems.length > 0 ? getPaginatedItems(allItems) : [];
      var itemsHtml = paginatedItems.length > 0 
        ? paginatedItems.map(function(item) { return renderItemCard(item, isAdmin); }).join('')
        : '<div class="empty-state"><div class="empty-icon">📭</div><p>暂无收藏</p>' +
          (state.advancedFilter.mediaType || state.advancedFilter.dateFrom || state.advancedFilter.dateTo 
            ? '<p style="color: var(--text-secondary); font-size: 14px;">尝试清除筛选条件</p>'
            : '') +
          '</div>';
      
      // 紧凑型工具栏
      var compactToolbarHtml = '<div class="compact-toolbar">';
      
      // 左侧：操作按钮
      if (isAdmin && allItems.length > 0) {
        compactToolbarHtml += '<div class="toolbar-group">';
        compactToolbarHtml += '<span class="group-label">操作:</span>';
        
        if (!state.batchMode) {
          compactToolbarHtml += '<button class="compact-btn" onclick="enterBatchMode()">📋 批量</button>';
        } else {
          compactToolbarHtml += '<button class="compact-btn primary" onclick="exitBatchMode()">✓ 完成</button>';
          compactToolbarHtml += '<button class="compact-btn" onclick="selectAllItems()">全选</button>';
          compactToolbarHtml += '<button class="compact-btn danger" onclick="batchDelete()" ' + 
            (state.selectedIds.length === 0 ? 'disabled' : '') + '>🗑️(' + state.selectedIds.length + ')</button>';
        }
        
        if (!state.batchMode && isAdmin) {
          compactToolbarHtml += '<button class="compact-btn" onclick="showImportModal()">📤 导入</button>';
          compactToolbarHtml += '<div class="compact-dropdown">' +
            '<button class="compact-btn">📥 导出 ▼</button>' +
            '<div class="compact-menu">' +
            '<button onclick="exportAs(\\'json\\')">📋 JSON</button>' +
            '<button onclick="exportAs(\\'markdown\\')">📝 Markdown</button>' +
            '<button onclick="exportAs(\\'html\\')">🌐 HTML</button>' +
            '</div></div>';
        }
        
        compactToolbarHtml += '</div>';
      }
      
      // 右侧：视图控件
      compactToolbarHtml += '<div class="toolbar-group">';
      compactToolbarHtml += '<span class="group-label">视图:</span>';
      compactToolbarHtml += '<select class="compact-select" onchange="changeSortBy(this.value)">' +
        '<option value="time-desc"' + (state.sortBy === 'time-desc' ? ' selected' : '') + '>最新</option>' +
        '<option value="time-asc"' + (state.sortBy === 'time-asc' ? ' selected' : '') + '>最旧</option>' +
        '<option value="tags-desc"' + (state.sortBy === 'tags-desc' ? ' selected' : '') + '>标签多</option>' +
        '<option value="tags-asc"' + (state.sortBy === 'tags-asc' ? ' selected' : '') + '>标签少</option>' +
        '</select>';
      compactToolbarHtml += '<select class="compact-select" onchange="changePageSize(this.value)">' +
        '<option value="20"' + (state.itemsPerPage === 20 ? ' selected' : '') + '>20条</option>' +
        '<option value="50"' + (state.itemsPerPage === 50 ? ' selected' : '') + '>50条</option>' +
        '<option value="100"' + (state.itemsPerPage === 100 ? ' selected' : '') + '>100条</option>' +
        '<option value="all"' + (state.itemsPerPage === 'all' ? ' selected' : '') + '>全部</option>' +
        '</select>';
      compactToolbarHtml += '<button class="compact-btn icon-btn" onclick="toggleFilterDrawer()" title="筛选">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>' +
        (state.advancedFilter.mediaType || state.advancedFilter.dateFrom || state.advancedFilter.dateTo ? ' <span class="notification-dot"></span>' : '') +
        '</button>';
      compactToolbarHtml += '</div>';
      
      compactToolbarHtml += '</div>';
      
      // 抽屉式筛选面板
      var filterDrawerHtml = '<div class="filter-drawer' + (state.showAdvancedFilter ? ' open' : '') + '">' +
        '<div class="filter-drawer-overlay" onclick="toggleFilterDrawer()"></div>' +
        '<div class="filter-drawer-content">' +
        '<div class="filter-drawer-header">' +
        '<h3>🔍 高级筛选</h3>' +
        '<button class="filter-close" onclick="toggleFilterDrawer()">×</button>' +
        '</div>' +
        '<div class="filter-drawer-body">' +
        '<div class="filter-section">' +
        '<label class="filter-section-label">媒体类型</label>' +
        '<select class="filter-drawer-select" onchange="setMediaTypeFilter(this.value)">' +
        '<option value=""' + (!state.advancedFilter.mediaType ? ' selected' : '') + '>全部</option>' +
        '<option value="photo"' + (state.advancedFilter.mediaType === 'photo' ? ' selected' : '') + '>📷 图片</option>' +
        '<option value="audio"' + (state.advancedFilter.mediaType === 'audio' ? ' selected' : '') + '>🎵 音频</option>' +
        '<option value="voice"' + (state.advancedFilter.mediaType === 'voice' ? ' selected' : '') + '>🎤 语音</option>' +
        '<option value="video"' + (state.advancedFilter.mediaType === 'video' ? ' selected' : '') + '>🎬 视频</option>' +
        '<option value="document"' + (state.advancedFilter.mediaType === 'document' ? ' selected' : '') + '>📎 文档</option>' +
        '<option value="none"' + (state.advancedFilter.mediaType === 'none' ? ' selected' : '') + '>📄 无媒体</option>' +
        '</select>' +
        '</div>' +
        '<div class="filter-section">' +
        '<label class="filter-section-label">日期范围</label>' +
        '<div class="filter-date-group">' +
        '<input type="date" class="filter-drawer-input" value="' + (state.advancedFilter.dateFrom || '') + '" onchange="setDateFromFilter(this.value)" placeholder="开始日期">' +
        '<span class="filter-date-sep">至</span>' +
        '<input type="date" class="filter-drawer-input" value="' + (state.advancedFilter.dateTo || '') + '" onchange="setDateToFilter(this.value)" placeholder="结束日期">' +
        '</div>' +
        '</div>' +
        '<div class="filter-section">' +
        '<label class="filter-section-label">快捷选项</label>' +
        '<div class="filter-shortcuts">' +
        '<button class="filter-shortcut" onclick="setDateShortcut(\\'today\\')">今天</button>' +
        '<button class="filter-shortcut" onclick="setDateShortcut(\\'week\\')">本周</button>' +
        '<button class="filter-shortcut" onclick="setDateShortcut(\\'month\\')">本月</button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="filter-drawer-footer">' +
        '<button class="filter-drawer-btn primary" onclick="applyFilterDrawer()">应用筛选</button>' +
        '<button class="filter-drawer-btn secondary" onclick="clearFilterDrawer()">清除筛选</button>' +
        '</div>' +
        '</div>' +
        '</div>';
      
      // 分页按钮 (保持原样)
      var paginationHtml = '';
      if (state.itemsPerPage !== 'all' && allItems.length > 0) {
        var totalPages = getTotalPages(allItems);
        if (totalPages > 1) {
          paginationHtml = '<div class="pagination">';
          if (state.currentPage > 1) {
            paginationHtml += '<button class="page-btn" onclick="goToPage(' + (state.currentPage - 1) + ')">上一页</button>';
          }
          var startPage = Math.max(1, state.currentPage - 2);
          var endPage = Math.min(totalPages, state.currentPage + 2);
          if (startPage > 1) {
            paginationHtml += '<button class="page-btn" onclick="goToPage(1)">1</button>';
            if (startPage > 2) {
              paginationHtml += '<span class="page-ellipsis">...</span>';
            }
          }
          for (var i = startPage; i <= endPage; i++) {
            if (i === state.currentPage) {
              paginationHtml += '<button class="page-btn active">' + i + '</button>';
            } else {
              paginationHtml += '<button class="page-btn" onclick="goToPage(' + i + ')">' + i + '</button>';
            }
          }
          if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
              paginationHtml += '<span class="page-ellipsis">...</span>';
            }
            paginationHtml += '<button class="page-btn" onclick="goToPage(' + totalPages + ')">' + totalPages + '</button>';
          }
          if (state.currentPage < totalPages) {
            paginationHtml += '<button class="page-btn" onclick="goToPage(' + (state.currentPage + 1) + ')">下一页</button>';
          }
          paginationHtml += '</div>';
        }
      }
      
      return compactToolbarHtml + filterDrawerHtml + itemsHtml + paginationHtml;
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
        '</div></div></div></div>' +
        '<div id="import-modal" class="modal"><div class="modal-content">' +
        '<div class="modal-header"><span class="modal-title">导入数据</span><button class="modal-close" onclick="hideImportModal()">×</button></div>' +
        '<div class="modal-body">' +
        '<div class="form-group"><label class="form-label">选择导出的 JSON 文件</label>' +
        '<input type="file" class="form-input" id="import-file" accept=".json" onchange="handleImportFile(event)"></div>' +
        '<div id="import-preview"></div>' +
        '</div>' +
        '</div></div>';
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
      
      // 初始化 Plyr 播放器和懒加载
      setTimeout(function() {
        initPlayers();
        initLazyLoad();
      }, 100);
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
      if (card) {
        card.classList.add('removing');
        // 动画结束后立即移除元素
        setTimeout(function() {
          if (card && card.parentNode) {
            card.parentNode.removeChild(card);
          }
        }, 300);
      }
      apiCall('POST', '/api/delete/' + idToDelete).then(function(data) {
        if (data.success) {
          state.items = state.items.filter(function(i) { return i.id !== idToDelete; });
          state.metadata.total_count = Math.max(0, (state.metadata.total_count || 0) - 1);
          showToast('已删除');
          // 更新计数显示但不重新渲染整个列表
          var statsBar = document.querySelector('.stats-bar');
          if (statsBar) {
            var statValue = statsBar.querySelector('.stat-value');
            if (statValue) statValue.textContent = state.metadata.total_count;
          }
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
      
      // 显示加载动画
      showLoading();
      
      // 异步加载初始数据
      loadData().then(function() {
        hideLoading();
        
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
      }).catch(function(err) {
        hideLoading();
        console.error('Failed to load initial data:', err);
        // 即使加载失败也渲染页面（显示空状态）
        render();
      });
      
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
    
    // PWA Service Worker 注册
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js')
          .then(function(registration) {
            console.log('SW registered:', registration.scope);
          })
          .catch(function(err) {
            console.log('SW registration failed:', err);
          });
      });
    }
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
      // PWA Manifest
      if (path === '/manifest.json' && method === 'GET') {
        return handleManifest(env);
      }
      
      // Service Worker
      if (path === '/sw.js' && method === 'GET') {
        return handleServiceWorker();
      }
      
      // Telegram Webhook
      if (path === '/telegram-webhook' && method === 'POST') {
        return handleTelegramWebhook(request, env, ctx);
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
      
      // 文件代理 API（安全地下载 Telegram 文件）
      if (path.startsWith('/api/file/') && method === 'GET') {
        const fileId = path.replace('/api/file/', '');
        return handleApiFileProxy(request, env, fileId);
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
          headers: { 
            'Content-Type': 'text/html; charset=utf-8',
            // HTML 可以缓存（因为数据已分离，通过 API 异步加载）
            // 浏览器缓存 1 小时，CDN 缓存 5 分钟
            'Cache-Control': 'public, max-age=3600, s-maxage=300',
            // 允许 CDN 缓存
            'CDN-Cache-Control': 'public, max-age=300'
          }
        });
      }
      
      return new Response('Method not allowed', { status: 405 });
      
    } catch (error) {
      console.error('Error:', error);
      return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
  }
};
