from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.security import require_session, serialize_id, safe_object_id, employee_reference_values

router = APIRouter(tags=["tasks"])


class TaskUpdate(BaseModel):
    status: Optional[str] = None
    progress: Optional[float] = None
    assigned_to: Optional[Any] = None
    notes: Optional[str] = None


@router.get("/api/tasks")
async def list_tasks(
    scope: Optional[str] = Query(default=None),
    ctx: dict = Depends(require_session),
):
    db, user, employee = ctx["db"], ctx["user"], ctx["employee"]
    query: dict[str, Any] = {}
    role = str(user.get("role") or "").lower()
    is_mgr = any(k in role for k in ("admin", "manager", "director", "executive"))
    if not is_mgr or (scope or "").lower() in ("personal", "mine"):
        values = employee_reference_values(employee.get("_id") or employee.get("employee_id"))
        query["$or"] = [
            {"assigned_to": {"$in": values}},
            {"assignee_id": {"$in": values}},
            {"employee_id": {"$in": values}},
        ]
    rows = await db["work_assignments"].find(query).sort("updated_at", -1).limit(200).to_list(200)
    return {"success": True, "tasks": [serialize_id(r) for r in rows], "items": [serialize_id(r) for r in rows]}


@router.get("/api/tasks/{task_id}")
async def get_task(task_id: str, ctx: dict = Depends(require_session)):
    db = ctx["db"]
    oid = safe_object_id(task_id)
    task = await db["work_assignments"].find_one({"_id": oid} if oid else {"_id": task_id})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"success": True, "task": serialize_id(task)}


@router.post("/api/tasks/{task_id}/start")
async def start_task(task_id: str, ctx: dict = Depends(require_session)):
    db = ctx["db"]
    oid = safe_object_id(task_id)
    filt = {"_id": oid} if oid else {"_id": task_id}
    result = await db["work_assignments"].update_one(
        filt,
        {
            "$set": {
                "status": "In Progress",
                "started_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await db["work_assignments"].find_one(filt)
    return {"success": True, "task": serialize_id(task)}


@router.post("/api/tasks/{task_id}/assign")
async def assign_task(task_id: str, body: TaskUpdate, ctx: dict = Depends(require_session)):
    db = ctx["db"]
    oid = safe_object_id(task_id)
    filt = {"_id": oid} if oid else {"_id": task_id}
    if body.assigned_to is None:
        raise HTTPException(status_code=400, detail="assigned_to is required")
    result = await db["work_assignments"].update_one(
        filt,
        {
            "$set": {
                "assigned_to": body.assigned_to,
                "status": "Assigned",
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await db["work_assignments"].find_one(filt)
    return {"success": True, "task": serialize_id(task)}


@router.patch("/api/tasks/{task_id}")
@router.put("/api/tasks/{task_id}")
async def update_task(task_id: str, body: TaskUpdate, ctx: dict = Depends(require_session)):
    db = ctx["db"]
    oid = safe_object_id(task_id)
    filt = {"_id": oid} if oid else {"_id": task_id}
    updates: dict[str, Any] = {"updated_at": datetime.now(timezone.utc)}
    if body.status is not None:
        updates["status"] = body.status
    if body.progress is not None:
        updates["progress"] = body.progress
    if body.assigned_to is not None:
        updates["assigned_to"] = body.assigned_to
    if body.notes is not None:
        updates["notes"] = body.notes
    result = await db["work_assignments"].update_one(filt, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await db["work_assignments"].find_one(filt)
    return {"success": True, "task": serialize_id(task)}
