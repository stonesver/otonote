export const DEFAULT_THEME = 'classic';

// Curated editorial paper palettes with verified WCAG AA (>= 4.5:1) contrast.
// Derived tokens stay in CSS; game colors keep their own identities.
const lightPalette = {
  'color-scheme': 'light',
  text: '#1b1f29', 'text-soft': '#383e4c', canvas: '#f4f5f7', surface: '#ffffff', 'surface-deep': '#e6e8ed',
  accent: '#2e5a9e', 'accent-bright': '#426fb4', secondary: '#f2b59b', 'secondary-ink': '#873a20', 'on-secondary': '#3b180c',
  border: '#cfd3dc', muted: '#5d6370', 'on-accent': '#fff',
  warning: '#8a5d22', 'warning-ink': '#6b4514', success: '#2c694d', 'success-ink': '#1e543b', danger: '#a63848', 'danger-ink': '#822533',
  'inverse-surface': '#1e222b', 'inverse-text': '#f8f9fb', 'inverse-muted': '#c0c5cf',
  'media-shade': '#0d1016', 'media-text': '#fff', 'shadow-color': '#141720', 'chart-5': '#665b9e',
};

export const THEME_PRESETS = [
  // Everyday palettes (redesigned)
  {
    id: 'classic', group: 'everyday',
    name: { 'zh-CN': '原版', en: 'Classic' },
    description: { 'zh-CN': '温润纸白 · 莓红与雾蓝', en: 'Warm ivory · Berry and mist blue' },
    tokens: {
      'color-scheme': 'light',
      text: '#141720', 'text-soft': '#252a36', canvas: '#f4f2ed', surface: '#fffefb', 'surface-deep': '#e5e1d8',
      accent: '#842c57', 'accent-bright': '#a34271', secondary: '#79aec2', 'secondary-ink': '#2c5d72', 'on-secondary': '#11131b',
      border: '#cbc6bd', muted: '#5f5a60', 'on-accent': '#fff',
      warning: '#8f6024', 'warning-ink': '#6e4716', success: '#2f6b51', 'success-ink': '#1f563e', danger: '#a83952', 'danger-ink': '#87263d',
      'inverse-surface': '#1a1e28', 'inverse-text': '#fffefb', 'inverse-muted': '#c6c3bc',
      'media-shade': '#080a10', 'media-text': '#fff', 'shadow-color': '#141720', 'chart-5': '#6f5b9e',
    },
  },
  {
    id: 'paper', group: 'everyday',
    name: { 'zh-CN': '晴空纸韵', en: 'Studio Cobalt' },
    description: { 'zh-CN': '钴蓝 · 柔桃', en: 'Cobalt · Soft peach' },
    tokens: { ...lightPalette, canvas: '#f3f5f8' },
  },
  {
    id: 'apricot', group: 'everyday',
    name: { 'zh-CN': '海盐薄荷', en: 'Sea Salt Mint' },
    description: { 'zh-CN': '松青 · 暖杏', en: 'Sea teal · Warm apricot' },
    tokens: {
      ...lightPalette, canvas: '#f2f7f6',
      accent: '#0f6b64', 'accent-bright': '#1b7a72', secondary: '#f0be7a', 'secondary-ink': '#734712', 'on-secondary': '#3d2408',
    },
  },
  {
    id: 'silver', group: 'everyday',
    name: { 'zh-CN': '星夜紫罗兰', en: 'Starlit Violet' },
    description: { 'zh-CN': '靛紫 · 冰青', en: 'Indigo violet · Ice cyan' },
    tokens: {
      ...lightPalette, canvas: '#f4f4f9',
      accent: '#4a4c9e', 'accent-bright': '#5b5db0', secondary: '#8dd0db', 'secondary-ink': '#1f5c68', 'on-secondary': '#103138',
    },
  },

  // Band signature color themes (distinct vivid band identities, separated from attribute hues)
  {
    id: 'band-mygo', group: 'band', bandId: 1,
    name: { 'zh-CN': 'MyGO!!!!!', en: 'MyGO!!!!!' },
    description: { 'zh-CN': '迷星碧青 · 珊瑚粉', en: 'Starlit teal · Coral rose' },
    tokens: {
      ...lightPalette, canvas: '#edf6f7', surface: '#fcffff', 'surface-deep': '#dcebed',
      accent: '#006d7d', 'accent-bright': '#0b8191', secondary: '#f29da8', 'secondary-ink': '#962c41', 'on-secondary': '#47101c',
    },
  },
  {
    id: 'band-avemujica', group: 'band', bandId: 2,
    name: { 'zh-CN': 'Ave Mujica', en: 'Ave Mujica' },
    description: { 'zh-CN': '月蚀暮紫 · 绯红丝绒', en: 'Gothic plum · Velvet crimson' },
    tokens: {
      ...lightPalette, canvas: '#f2eff6', surface: '#fdfcff', 'surface-deep': '#e4dfec',
      accent: '#4c245e', 'accent-bright': '#633378', secondary: '#e38fa0', 'secondary-ink': '#8f223b', 'on-secondary': '#420d19',
    },
  },
  {
    id: 'band-mewtype', group: 'band', bandId: 3,
    name: { 'zh-CN': '梦限大MewType', en: 'Yumemita' },
    description: { 'zh-CN': '星梦洋红 · 幻彩薄荷', en: 'Cyber magenta · Electric mint' },
    tokens: {
      ...lightPalette, canvas: '#fcf1f6', surface: '#fffcfe', 'surface-deep': '#f2dfe9',
      accent: '#b51d68', 'accent-bright': '#cc2c7b', secondary: '#7ce0cc', 'secondary-ink': '#116355', 'on-secondary': '#07332b',
    },
  },
  {
    id: 'band-millsage', group: 'band', bandId: 4,
    name: { 'zh-CN': 'millsage', en: 'millsage' },
    description: { 'zh-CN': '鼠尾草绿 · 暮霭薰衣草', en: 'Botanical sage · Soft lavender' },
    tokens: {
      ...lightPalette, canvas: '#eff7f3', surface: '#fcfffd', 'surface-deep': '#dfece5',
      accent: '#286954', 'accent-bright': '#367d66', secondary: '#bab6eb', 'secondary-ink': '#46418c', 'on-secondary': '#1f1c47',
    },
  },
  {
    id: 'band-dumbrock', group: 'band', bandId: 5,
    name: { 'zh-CN': '一家Dumb Rock!', en: 'Ikka Dumb Rock!' },
    description: { 'zh-CN': '赤焰橙红 · 朝阳金', en: 'Blaze vermilion · Sunburst gold' },
    tokens: {
      ...lightPalette, canvas: '#fcf3ec', surface: '#fffdfb', 'surface-deep': '#f0e3d8',
      accent: '#b33812', 'accent-bright': '#c74820', secondary: '#f7cd63', 'secondary-ink': '#754e0b', 'on-secondary': '#402904',
    },
  },

  // Dark palette (redesigned)
  {
    id: 'night', group: 'dark',
    name: { 'zh-CN': '夜间', en: 'Night' },
    description: { 'zh-CN': '曜石蓝灰 · 月光银与暖琥珀', en: 'Slate obsidian · Moonlight silver & amber' },
    tokens: {
      'color-scheme': 'dark',
      text: '#eff2f7', 'text-soft': '#cfd5e0', canvas: '#14171d', surface: '#1c2029', 'surface-deep': '#262c38',
      accent: '#aec1eb', 'accent-bright': '#cad8f7', secondary: '#dfbe92', 'secondary-ink': '#e8cda8', 'on-secondary': '#292014',
      border: '#49505e', muted: '#a5adbc', 'on-accent': '#161b26',
      warning: '#d9b578', 'warning-ink': '#e8cca0', success: '#8ec4a8', 'success-ink': '#b4dcc7', danger: '#e39ea6', 'danger-ink': '#f2bfc5',
      'inverse-surface': '#101318', 'inverse-text': '#f2f4f8', 'inverse-muted': '#b2b9c7',
      'media-shade': '#090b0f', 'media-text': '#fff', 'shadow-color': '#06070a', 'chart-5': '#b5a8e0',
    },
  },

  // Occasion palettes (redesigned)
  {
    id: 'new-year', group: 'occasion',
    name: { 'zh-CN': '新年', en: 'New Year' },
    description: { 'zh-CN': '宣纸朱红 · 鎏金', en: 'Rice paper vermilion · Gold' },
    tokens: {
      ...lightPalette, canvas: '#faf3ea',
      accent: '#9e3226', 'accent-bright': '#b04032', secondary: '#f2ca68', 'secondary-ink': '#734f16', 'on-secondary': '#452c08',
    },
  },
  {
    id: 'christmas', group: 'occasion',
    name: { 'zh-CN': '圣诞', en: 'Christmas' },
    description: { 'zh-CN': '霜松绿 · 冬青红', en: 'Frost pine · Holly red' },
    tokens: {
      ...lightPalette, canvas: '#eff6f4',
      accent: '#215c41', 'accent-bright': '#2f7052', secondary: '#b83b37', 'secondary-ink': '#962d2a', 'on-secondary': '#ffffff',
    },
  },
  {
    id: 'anniversary', group: 'occasion',
    name: { 'zh-CN': '周年', en: 'Anniversary' },
    description: { 'zh-CN': '星夜深蓝 · 香槟金', en: 'Starlight navy · Champagne gold' },
    tokens: {
      ...lightPalette, canvas: '#f1f4fa',
      accent: '#244770', 'accent-bright': '#355b87', secondary: '#f0c762', 'secondary-ink': '#735318', 'on-secondary': '#422e0a',
    },
  },

  // Event attribute palettes (redesigned with cleaner tinted canvases)
  {
    id: 'attribute-red', group: 'attribute', attribute: 1,
    name: { 'zh-CN': '红赤', en: 'Red' },
    description: { 'zh-CN': '红赤 · 雾青', en: 'Crimson · Mist aqua' },
    tokens: {
      ...lightPalette, canvas: '#faf3f5',
      accent: '#a82c4e', 'accent-bright': '#bd3e60', secondary: '#80ccd1', 'secondary-ink': '#225e64', 'on-secondary': '#10363a',
    },
  },
  {
    id: 'attribute-azure', group: 'attribute', attribute: 2,
    name: { 'zh-CN': '绀碧', en: 'Azure' },
    description: { 'zh-CN': '绀碧 · 暖杏', en: 'Azure · Soft amber' },
    tokens: {
      ...lightPalette, canvas: '#f2f6fa',
      accent: '#245f9c', 'accent-bright': '#3672b0', secondary: '#f5c47c', 'secondary-ink': '#754b14', 'on-secondary': '#422908',
    },
  },
  {
    id: 'attribute-jade', group: 'attribute', attribute: 3,
    name: { 'zh-CN': '翡翠', en: 'Jade' },
    description: { 'zh-CN': '翡翠 · 樱粉', en: 'Jade · Cherry pink' },
    tokens: {
      ...lightPalette, canvas: '#f2f8f5',
      accent: '#1f6e4b', 'accent-bright': '#2f7f5b', secondary: '#efb0c3', 'secondary-ink': '#8c3658', 'on-secondary': '#4c1a2e',
    },
  },
  {
    id: 'attribute-gold', group: 'attribute', attribute: 4,
    name: { 'zh-CN': '山吹', en: 'Golden Yellow' },
    description: { 'zh-CN': '山吹 · 晴空蓝', en: 'Golden ochre · Sky blue' },
    tokens: {
      ...lightPalette, canvas: '#faf7ef',
      accent: '#7d5712', 'accent-bright': '#91671b', secondary: '#8cbce6', 'secondary-ink': '#2b5a82', 'on-secondary': '#153450',
    },
  },
  {
    id: 'attribute-violet', group: 'attribute', attribute: 5,
    name: { 'zh-CN': '紫苑', en: 'Purple' },
    description: { 'zh-CN': '紫苑 · 嫩绿', en: 'Violet · Spring sage' },
    tokens: {
      ...lightPalette, canvas: '#f6f3fa',
      accent: '#6d489c', 'accent-bright': '#7f5ab0', secondary: '#b8d984', 'secondary-ink': '#4a6121', 'on-secondary': '#27360f',
    },
  },
];
