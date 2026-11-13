import fs from 'node:fs/promises';

export async function artworkInfo() {
  const credits = JSON.parse(await fs.readFile(new URL('../assets/credits.json', import.meta.url), 'utf8'));
  return {
    ...credits,
    message: [
      'DragonGirlBackground — Artwork credits / 图片署名',
      'Original GPT dragon-girl character and reference artwork: ZipZipPipe.',
      '原角色与参考立绘作者：ZipZipPipe。',
      'Sources / 来源：' + credits.sources.map(source => source.url).join('\n'),
      'Wallpaper adaptation: AI-assisted white contour line art, violet eyes, transparent background; prepared by ccy1430 using OpenAI ImageGen.',
      '背景改编：ccy1430 使用 OpenAI ImageGen 制作白线稿、紫色眼睛、透明底及竖幅构图。',
      'Non-commercial use only. Retain the artist credit, source links, and artwork notices when sharing.',
      '仅限非商业使用；分享时保留作者署名、来源链接和素材许可说明。',
      'No standard CC license has been confirmed for this GPT artwork. The source author’s CC BY-NC-SA 4.0 statement explicitly concerns the DeepSeek character.',
      'Statement / 图片引用声明：' + credits.noticeURL,
      'Code is MIT; that license does not cover the character artwork.'
    ].join('\n')
  };
}
