import type { ProcessTimelineItem, ToolCallTrace } from '../types/chat';
import { AgentToolName } from './toolNames';
import { toObject } from './json';
import { unwrapToolResultEnvelope } from './toolMeta';

export interface ReadToolImage {
  key: string;
  imageId: string;
  ext: 'png' | 'jpg';
  path: string;
}

export type ImageProcessItem = ProcessTimelineItem & { images?: ReadToolImage[] };

/** 只有成功回执中的缓存标识可以取图，不能把参数路径当成预览地址。 */
export function resolveReadToolImages(tool: ToolCallTrace): ReadToolImage[] {
  if (tool.toolName !== AgentToolName.ReadImage || tool.status !== 'success') return [];
  const receipt = toObject(unwrapToolResultEnvelope(tool.result));
  if (receipt.ok !== true || !Array.isArray(receipt.images)) return [];
  const images: ReadToolImage[] = [];
  for (const [index, image] of receipt.images.entries()) {
    if (!image || typeof image.imageId !== 'string' || !/^[0-9a-f]{16}$/.test(image.imageId)
      || (image.ext !== 'png' && image.ext !== 'jpg') || typeof image.path !== 'string') return [];
    images.push({ key: `${tool.id}-${index}`, imageId: image.imageId, ext: image.ext, path: image.path });
  }
  return images;
}

/** 仅合并相邻的成功读图，避免把图片挪到其他工具或思考之前。 */
export function groupReadImageTools(items: ProcessTimelineItem[], sessionId?: string | number): ImageProcessItem[] {
  if (!sessionId || !/^[1-9]\d*$/.test(String(sessionId))) return items;
  const grouped: ImageProcessItem[] = [];
  for (const item of items) {
    const images = item.type === 'tool' && item.tool ? resolveReadToolImages(item.tool) : [];
    const previous = grouped.at(-1);
    if (images.length && previous?.images) previous.images.push(...images);
    else grouped.push(images.length ? { ...item, images } : { ...item });
  }
  return grouped;
}
