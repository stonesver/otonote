const zh = {
  select: "选段分享", cancel: "退出选段", hint: "点选起止两句，即可生成长图或复制文字。",
  chooseEnd: "再点一句确定终点，或直接分享当前单句。", chosen: "已选第 {start}–{end} 句 · 共 {count} 句",
  line: "选择第 {n} 句", reset: "重选", generate: "生成长图", busy: "正在生成…",
  preview: "剧情长图预览", save: "保存 PNG", share: "系统分享", close: "关闭预览", edit: "调整选段",
  tip: "支持复制图片或保存 PNG，手机端可长按保存。", excerpt: "剧情节选",
  limit: "单张最多选择 80 句，请缩短选段。", tooTall: "这段内容太长，请减少对白后重试。",
  error: "图片生成失败，请重试或缩短选段。", shareError: "暂时无法调用系统分享，请先复制或保存图片。",
  avatarFallback: "部分头像未能加载，已用名字代替。", ready: "已生成", empty: "请点选对白",
  copyText: "复制文字", copiedText: "已复制文字", copyImage: "复制图片", copiedImage: "已复制图片",
  copyImageError: "当前浏览器不支持直接复制图片，请点击保存 PNG。",
  copyLink: "复制链接", copiedLink: "已复制链接", copyLine: "复制此句", quoteFromHere: "从此处截长图",
  themeLight: "浅色纸面", themeDark: "深色夜读", searchToggle: "搜索对白",
  chatStage: "手机聊天", stampLabel: "发送了一个表情贴图",
};
export type StoryShareCopy = Record<keyof typeof zh, string>;
const en: StoryShareCopy = {
  select: "Share excerpt", cancel: "Done", hint: "Pick a start and end line to create an image or copy text.",
  chooseEnd: "Pick an ending line, or share this single line right away.", chosen: "Lines {start}–{end} · {count} selected",
  line: "Select line {n}", reset: "Reset", generate: "Create image", busy: "Creating…",
  preview: "Story quote card", save: "Save PNG", share: "Share", close: "Close preview", edit: "Edit selection",
  tip: "Copy the image directly or save as PNG. On mobile, touch and hold to save.", excerpt: "Story excerpt",
  limit: "Select up to 80 lines per image. Please shorten your selection.", tooTall: "This excerpt is too long. Select fewer lines and try again.",
  error: "Could not create the image. Try again or select fewer lines.", shareError: "System sharing is unavailable. Copy or save the image instead.",
  avatarFallback: "Some portraits could not load. Names are shown instead.", ready: "Ready", empty: "Select lines to share",
  copyText: "Copy text", copiedText: "Text copied", copyImage: "Copy image", copiedImage: "Image copied",
  copyImageError: "Direct image copy is unavailable in this browser. Save PNG instead.",
  copyLink: "Copy link", copiedLink: "Link copied", copyLine: "Copy line", quoteFromHere: "Quote from here",
  themeLight: "Light paper", themeDark: "Dark night", searchToggle: "Find dialogue",
  chatStage: "Chat messages", stampLabel: "Sent a sticker",
};
const tw: StoryShareCopy = {
  select: "選段分享", cancel: "退出選段", hint: "點選起止兩句，即可生成長圖或複製文字。",
  chooseEnd: "再點一句確定終點，或直接分享當前單句。", chosen: "已選第 {start}–{end} 句 · 共 {count} 句",
  line: "選擇第 {n} 句", reset: "重選", generate: "生成長圖", busy: "正在生成…",
  preview: "劇情長圖預覽", save: "儲存 PNG", share: "系統分享", close: "關閉預覽", edit: "調整選段",
  tip: "支援直接複製圖片貼上，或儲存 PNG 分享；手機端可長按儲存。", excerpt: "劇情節選",
  limit: "單張最多選擇 80 句，請縮短選段。", tooTall: "這段內容太長，請減少對白後重試。",
  error: "圖片生成失敗，請重試或縮短選段。", shareError: "暫時無法呼叫系統分享，請先複製或儲存圖片。",
  avatarFallback: "部分頭像未能載入，已用名字代替。", ready: "已生成", empty: "請點選對白",
  copyText: "複製文字", copiedText: "已複製文字", copyImage: "複製圖片", copiedImage: "已複製圖片",
  copyImageError: "目前瀏覽器不支援直接複製圖片，請點擊儲存 PNG。",
  copyLink: "複製連結", copiedLink: "已複製連結", copyLine: "複製此句", quoteFromHere: "從此處截長圖",
  themeLight: "淺色紙面", themeDark: "深色夜讀", searchToggle: "搜尋對白",
  chatStage: "手機聊天", stampLabel: "傳送了一個表情貼圖",
};
const ja: StoryShareCopy = {
  select: "抜粋を共有", cancel: "選択を終了", hint: "最初と最後の行を選ぶと、画像作成やテキストコピーができます。",
  chooseEnd: "最後の行を選ぶか、この1行だけで共有できます。", chosen: "{start}–{end} 行 · {count} 行を選択中",
  line: "{n} 行目を選択", reset: "やり直す", generate: "画像を作成", busy: "作成中…",
  preview: "ストーリー画像プレビュー", save: "PNG を保存", share: "共有", close: "プレビューを閉じる", edit: "選択を変更",
  tip: "画像をコピーまたは PNG で保存できます。スマホでは長押し保存も可能です。", excerpt: "ストーリー抜粋",
  limit: "1枚につき80行まで選択できます。選択範囲を短くしてください。", tooTall: "内容が長すぎます。行数を減らして再試行してください。",
  error: "画像を作成できませんでした。再試行するか行数を減らしてください。", shareError: "直接共有できません。コピーまたは保存してください。",
  avatarFallback: "一部のアイコンを読み込めなかったため、名前で表示しています。", ready: "作成完了", empty: "行を選択してください",
  copyText: "テキストをコピー", copiedText: "コピーしました", copyImage: "画像をコピー", copiedImage: "画像をコピーしました",
  copyImageError: "このブラウザでは画像コピーに対応していません。PNG を保存してください。",
  copyLink: "リンクをコピー", copiedLink: "リンクをコピーしました", copyLine: "このセリフをコピー", quoteFromHere: "ここから画像を作成",
  themeLight: "ライト紙面", themeDark: "ダーク夜読", searchToggle: "セリフ検索",
  chatStage: "チャット", stampLabel: "スタンプを送信しました",
};
export function getStoryShareCopy(locale: string): StoryShareCopy {
  return ({ "zh-CN": zh, "zh-TW": tw, en, ja })[locale] || en;
}
