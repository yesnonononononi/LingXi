/** 模型用途与连接配置分开，生图模型只能作为辅助模型调用。 */
export function isImageModel(model: {provider?: string | null}): boolean {
  return model.provider === 'default-image-model';
}
