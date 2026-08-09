import logging
import os

from dotenv import load_dotenv
def initEnv():
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", ".env"))
    logging.info("init env success")
    print("init env success")
initEnv()