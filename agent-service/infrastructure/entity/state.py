from typing import Annotated
from langgraph.graph import add_messages, StateGraph
from typing_extensions import TypedDict



class State (TypedDict):
    messages:Annotated[list,add_messages]

def buildState(input:str):
    return {"messages":[{"role":"user","content":input}]}


