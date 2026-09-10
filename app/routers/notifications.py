from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, Query

from app.security import require_session, serialize_id, safe_object_id

router = APIRouter(tags=["notifications"])


@router.get("/api/notifications")
async def list_notifications(
    unread: Optional[int] = Query(default=None),
    scope: Optional[str] = Query(default=None),
    ctx: dict = Depends(require_session),
):
    db, user, employee = ctx["db"], ctx["user"], ctx["employee"]
    query: dict = {}
    # Prefer personal notifications for this user/employee
    user_id = user.get("_id")
    emp_id = employee.get("_id") or employee.get("employee_id")
    or_clause = []
    if user_id is not None:
        or_clause.append({"user_id": user_id})
        or_clause.append({"user_id": str(user_id)})
    if emp_id is not None:
        or_clause.append({"employee_id": emp_id})
        or_clause.append({"employee_id": str(emp_id)})
    if or_clause:
        query["$or"] = or_clause
    if unread in (1, "1", True):
        query["read"] = {"$ne": True}

    rows = await db["notifications"].find(query).sort("created_at", -1).limit(100).to_list(100)
    return {"success": True, "notifications": [serialize_id(r) for r in rows], "items": [serialize_id(r) for r in rows]}


@router.get("/api/notifications/unread-count")
async def unread_count(ctx: dict = Depends(require_session)):
    db, user, employee = ctx["db"], ctx["user"], ctx["employee"]
    or_clause = []
    if user.get("_id") is not None:
        or_clause += [{"user_id": user["_id"]}, {"user_id": str(user["_id"])}]
    emp_id = employee.get("_id") or employee.get("employee_id")
    if emp_id is not None:
        or_clause += [{"employee_id": emp_id}, {"employee_id": str(emp_id)}]
    query: dict = {"read": {"$ne": True}}
    if or_clause:
        query["$or"] = or_clause
    count = await db["notifications"].count_documents(query)
    return {"success": True, "count": count, "unread": count}


@router.post("/api/notifications/read-all")
@router.post("/api/notifications/mark-all-read")
async def mark_all_read(ctx: dict = Depends(require_session)):
    db, user, employee = ctx["db"], ctx["user"], ctx["employee"]
    or_clause = []
    if user.get("_id") is not None:
        or_clause += [{"user_id": user["_id"]}, {"user_id": str(user["_id"])}]
    emp_id = employee.get("_id") or employee.get("employee_id")
    if emp_id is not None:
        or_clause += [{"employee_id": emp_id}, {"employee_id": str(emp_id)}]
    query: dict = {"read": {"$ne": True}}
    if or_clause:
        query["$or"] = or_clause
    await db["notifications"].update_many(
        query, {"$set": {"read": True, "read_at": datetime.now(timezone.utc)}}
    )
    return {"success": True}


@router.post("/api/notifications/{notification_id}/read")
async def mark_one_read(notification_id: str, ctx: dict = Depends(require_session)):
    db = ctx["db"]
    oid = safe_object_id(notification_id)
    filt = {"_id": oid} if oid else {"_id": notification_id}
    await db["notifications"].update_one(
        filt, {"$set": {"read": True, "read_at": datetime.now(timezone.utc)}}
    )
    return {"success": True}
