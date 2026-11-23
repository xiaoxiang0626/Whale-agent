import { stripVTControlCharacters } from 'node:util';

/** @param value 模型文本或文件预览。 @returns 去除终端控制序列但保留换行的显示文本，不改变原消息。 */
export function displayText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n/g, '\n').replace(/\r/g, '')
    .replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
