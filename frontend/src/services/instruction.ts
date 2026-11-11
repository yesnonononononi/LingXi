import http from './interceptor';
import type {Result} from './types';
import type {InstructionVO} from '../types/chat';

/**
 * 指令预测 API（对应后端 InstructionController）。
 *
 * <p>后端只有一个入口：这一轮有旧预测就返回旧的，没有才生成。**没有「生成」与「查询」两个接口**，
 * 也没有失效/刷新入口 —— 每轮一条是后端保证的语义，前端不需要也不应该自己维护缓存。</p>
 */
export class InstructionAPI {
  static async next(sessionId: string | number, turnId: string | number): Promise<Result<InstructionVO | null>> {
    // 雪花 ID 一律按字符串下发：走 JSON 数字会被 JS 抹掉精度。
    const query = `?sessionId=${encodeURIComponent(String(sessionId))}&turnId=${encodeURIComponent(String(turnId))}`;
    return http.get<any, Result<InstructionVO | null>>(`/instruction/next${query}`);
  }
}