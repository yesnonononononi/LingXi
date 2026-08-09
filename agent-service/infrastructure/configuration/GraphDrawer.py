
from langgraph.graph.state import CompiledStateGraph

from infrastructure.entity.state import State


def draw(graph:CompiledStateGraph[State]):
    try:
        print(graph.get_graph().draw_mermaid())
    except Exception:
        print("绘制流程图失败",Exception)
        pass