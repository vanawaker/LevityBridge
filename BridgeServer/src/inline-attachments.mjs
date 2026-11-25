export function stripInlineAttachmentMarkdown(text) {
  return String(text ?? '')
    .replace(/!\[([^\]\r\n]*)\]\(levity-attachment:\/\/[^)\s]+\)/gi, (_, alt) => {
      const caption = alt.replace(/\\\|/g, '|').trim();
      return caption ? `[图片: ${caption}]` : '[图片]';
    })
    .replace(/levity-attachment:\/\/[^\s<>)\]`|"']*/gi, '[图片]');
}
