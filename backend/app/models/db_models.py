from sqlalchemy import Column, String, Integer, DateTime, JSON, Float
from sqlalchemy.orm import DeclarativeBase
from datetime import datetime


class Base(DeclarativeBase):
    pass


class TownKnowledgeBaseDB(Base):
    __tablename__ = "town_knowledge_bases"

    town = Column(String, primary_key=True)
    current_analysis = Column(JSON, nullable=False)
    confidence = Column(JSON, default={})
    changelog = Column(JSON, default=[])
    watch_items = Column(JSON, default=[])
    marathon_started = Column(DateTime, default=datetime.utcnow)
    last_run_at = Column(DateTime, default=datetime.utcnow)
    total_runs = Column(Integer, default=0)


class DailySnapshotDB(Base):
    __tablename__ = "daily_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    town = Column(String, nullable=False, index=True)
    date = Column(String, nullable=False)
    raw_demographics = Column(JSON)
    raw_commercial = Column(JSON)
    raw_market_intel = Column(JSON)
    tool_calls = Column(JSON)
    fetch_failures = Column(JSON)
    verification_report = Column(JSON)
    run_summary = Column(String)


class TrendSeriesDB(Base):
    __tablename__ = "trend_series"

    id = Column(Integer, primary_key=True, autoincrement=True)
    town = Column(String, nullable=False, index=True)
    metric = Column(String, nullable=False)
    date = Column(String, nullable=False)
    value = Column(Float)
    source = Column(String)
