
  (() => {
    'use strict';

    // ------------------------------
    // State & constants
    // ------------------------------
    const STORAGE_KEY = 'weekly_scheduler_v1';
    const LEGACY_STORAGE_KEY = 'weeklySchedulerState';
    const DEBUG = true;
    const APP_BUILD = '2026-02-09T23:42:00Z';

    /** @typedef {{ id:string; name:string; createdAt:string; deadline:string; initialEstimateMs:number; estimateMs:number; loggedMs:number; status:'active'|'done'|'archived'; completedAt?:string; lastProgressAt?:string; lastEditedAt?:string; }} Task */
    /** @typedef {{ taskId:string; start:string; end:string; }} Segment */
    /** @typedef {{ breakId:string; start:string; end:string; }} BreakSegment */
    /** @typedef {{ maxHoursPerDay:number; workStart:string; workEnd:string; workDays:boolean[]; timeStepMin:number; }} Settings */
    /** @typedef {{ settings:Settings; tasks:Task[]; schedule:Segment[]; breaks:BreakSegment[]; lastScheduledAt:string; }} State */

    const DEFAULT_SETTINGS = {
      maxHoursPerDay: 8,
      workStart: '09:00',
      workEnd: '17:00',
      workDays: [true, true, true, true, true, false, false],
      timeStepMin: 15
    };

    const HOUR_MS = 3600000;
    const MIN_MS = 60000;
    const DAY_MS = 24 * HOUR_MS;
    const MIN_BREAK_MS = 5 * MIN_MS;

    /** @type {State} */
    let state = loadState();

    // Ensure breaks array exists
    if (!Array.isArray(state.breaks)) state.breaks = [];

    const runtime = {
      activeTaskId: null,
      activeStartedAt: null
    };
    const splitLogMemo = new Set();

    let lastMinuteKey = '';
    let modalStack = [];

    if (!Array.isArray(state.schedule)) state.schedule = [];
    if (!Array.isArray(state.breaks)) state.breaks = [];
    debugLog('script_loaded', { build: APP_BUILD, href: location.href, storageKey: STORAGE_KEY });
    rebuildSchedule('boot', false);
    render();
    setInterval(tick, 1000);
    initializeAutoPersistence();
    window.schedulerDebug = {
      dumpStorage(){
        const primary = localStorage.getItem(STORAGE_KEY);
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        const info = {
          href: location.href,
          storageKey: STORAGE_KEY,
          hasPrimary: !!primary,
          primaryBytes: primary ? primary.length : 0,
          hasLegacy: !!legacy,
          legacyBytes: legacy ? legacy.length : 0,
          inMemory: {
            tasks: (state.tasks || []).length,
            schedule: (state.schedule || []).length,
            breaks: (state.breaks || []).length,
            lastScheduledAt: state.lastScheduledAt
          }
        };
        console.log('[WeeklyScheduler debug] storage_dump', info);
        return info;
      },
      forceSave(label = 'manual'){
        saveState(state, `manual:${label}`);
      },
      clearStorage(){
        clearStoredState();
        console.log('[WeeklyScheduler debug] storage_cleared');
      }
    };
    debugLog('debug_helpers_ready', 'window.schedulerDebug.dumpStorage()');

    function tick(){
      const now = new Date();
      const minuteKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}-${pad2(now.getHours())}-${pad2(now.getMinutes())}`;

      if (minuteKey !== lastMinuteKey){
        lastMinuteKey = minuteKey;
        rebuildSchedule('minute tick', false);
      } else {
        const changed = syncActiveRuntime(now);
        if (changed){
          saveState(state, 'tick:runtime_changed');
        }
      }

      render();
    }

    function initializeAutoPersistence(){
      const flush = () => saveState(state, 'autosave:timer_or_lifecycle');
      setInterval(flush, 10000);
      window.addEventListener('beforeunload', flush);
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) flush();
      });
    }

    // ------------------------------
    // Render main UI
    // ------------------------------
    function render(){
      const app = document.getElementById('app');
      if (!app) return;

      const now = new Date();
      const active = state.tasks.filter(t => t.status === 'active');
      const segments = state.schedule || [];

      const activeSeg = getCurrentSegment(now, segments);
      const activeTask = activeSeg ? state.tasks.find(t => t.id === activeSeg.taskId) : null;
      const activeElapsed = activeSeg ? Math.max(0, now.getTime() - new Date(activeSeg.start).getTime()) : 0;

      app.innerHTML = `
        <header>
          <div class="headerInner">
            <div class="topRow">
              <div class="nowBox">
                <div class="nowTime">${formatTimeNice(now)}</div>
                <div class="nowDate">${formatDateNice(now)}</div>
              </div>
            </div>
            <div class="buttonRow">
              <div class="buttonLeft">
                <button id="btnAddTask" type="button" class="btn primary" onclick="openNewTask()">Add task</button>
              </div>
              <div class="buttonRight">
                <button id="btnFullTaskList" type="button" class="btn" onclick="openTaskList()">Full task list</button>
                <button id="btnSettings" type="button" class="btn ghost" onclick="openSettings()">Settings</button>
              </div>
            </div>
            <div class="activeNow">
              ${activeTask ? `
                <span>Current task: <b>${escapeHtml(activeTask.name)}</b></span>
                <span class="muted">Active for ${formatDurationMs(activeElapsed)} (${formatTimeRange(new Date(activeSeg.start), new Date(activeSeg.end))})</span>
              ` : `
                <span>No active task right now.</span>
                <span class="muted">Planner auto-reschedules unfinished tasks each minute.</span>
              `}
            </div>
          </div>
        </header>
        <main>
          <div class="wrap">
            ${renderCalendar(now, active, segments, state.breaks)}
          </div>
        </main>
      `;

      const addBtn = app.querySelector('#btnAddTask');
      if (addBtn) addBtn.onclick = () => window.openNewTask();

      const listBtn = app.querySelector('#btnFullTaskList');
      if (listBtn) listBtn.onclick = () => window.openTaskList();

      const settingsBtn = app.querySelector('#btnSettings');
      if (settingsBtn) settingsBtn.onclick = () => window.openSettings();
    }

    function renderCalendar(now, tasks, segments, breaks){
      const day0 = startOfDay(now);
      const days = [];
      for (let i = 0; i < 7; i++){
        days.push(addDays(day0, i));
      }

      const s = state.settings;
      const [wsh, wsm] = s.workStart.split(':').map(Number);
      const [weh, wem] = s.workEnd.split(':').map(Number);
      const workStart = wsh + wsm / 60;
      const workEnd = weh + wem / 60;
      const workHours = Math.max(1, workEnd - workStart);

      const header = document.querySelector('header');
      const headerHeight = header ? header.getBoundingClientRect().height : 180;
      const availableHeight = Math.max(260, window.innerHeight * 0.95 - headerHeight - 20);
      const hourHeight = clamp(availableHeight / workHours, 24, 92);
      document.documentElement.style.setProperty('--hourHeight', `${hourHeight}px`);

      const labels = [];
      for (let h = Math.ceil(workStart); h <= Math.floor(workEnd); h++){
        if (h >= workStart && h <= workEnd) labels.push(h);
      }

      return `
        <div class="calendarShell" style="--workHours:${workHours};">
          <div class="weekGrid">
            <div class="timeColumn">
              <div class="timeColumnHeader">Time</div>
              <div class="timeColumnBody">
                ${labels.map(h => {
                  const y = (h - workStart) * hourHeight;
                  return `<div class="hourLabel" style="top:${y}px;">${formatHour(h)}</div>`;
                }).join('')}
              </div>
            </div>
            ${days.map((d, i) => renderDayColumn(d, i, tasks, segments, breaks, now, workStart, workEnd, hourHeight)).join('')}
          </div>
          ${renderTimeLine(now, workStart, workEnd, hourHeight)}
        </div>
      `;
    }

    function renderDayColumn(day, dayIndex, tasks, segments, breaks, now, workStart, workEnd, hourHeight){
      const dow = day.toLocaleDateString('en-US', { weekday: 'short' });
      const isToday = isSameDay(day, now);

      const taskById = new Map(tasks.map(t => [t.id, t]));
      const workWindow = getWorkWindowForDay(day, state.settings);

      const daySegsRaw = segments
        .map(seg => clipSegmentToWindow(seg, workWindow.startMs, workWindow.endMs))
        .filter(Boolean)
        .sort((a, b) => a.startMs - b.startMs);

      const dayBreaks = normalizeBreakCollection(breaks, state.settings)
        .map(br => clipBreakToWindow(br, workWindow.startMs, workWindow.endMs))
        .filter(Boolean)
        .sort((a, b) => a.startMs - b.startMs);

      const daySegs = [];
      daySegsRaw.forEach(seg => {
        const task = taskById.get(seg.taskId);
        if (!task) return;
        daySegs.push(...splitSegmentByDeadline(seg, task));
      });
      daySegs.sort((a, b) => new Date(a.start) - new Date(b.start));

      const items = [];
      daySegsRaw.forEach(seg => items.push({ start: seg.startMs, end: seg.endMs, type: 'task' }));
      dayBreaks.forEach(br => items.push({ start: br.startMs, end: br.endMs, type: 'break' }));
      items.sort((a, b) => a.start - b.start);

      const connectors = [];
      for (let i = 0; i < items.length - 1; i++){
        const cur = items[i];
        const nxt = items[i + 1];
        let t = cur.end;
        if (nxt.start > cur.end){
          t = cur.end + Math.floor((nxt.start - cur.end) / 2);
        }
        const dt = new Date(t);
        const h = dt.getHours() + dt.getMinutes() / 60;
        if (h >= workStart && h <= workEnd){
          const top = (h - workStart) * hourHeight;
          connectors.push(`<button class="segmentConnector" style="top:${top}px;" onclick="createBreakAtConnector('${dt.toISOString()}')" title="Add break"></button>`);
        }
      }

      const workHours = workEnd - workStart;

      return `
        <div class="dayCol ${isToday ? 'today' : ''}">
          <div class="dayHeader">
            <div class="dow">${dow}</div>
            <div class="date">${formatDayMonth(day)}</div>
          </div>
          <div class="dayBody" style="--workHours:${workHours};">
            ${connectors.join('')}
            ${dayBreaks.map(br => renderBreak(br, workStart, hourHeight)).join('')}
            ${daySegs.map(seg => renderSegment(seg, tasks, workStart, now, hourHeight)).join('')}
          </div>
        </div>
      `;
    }

    function renderSegment(seg, tasks, workStart, now, hourHeight){
      const task = tasks.find(t => t.id === seg.taskId);
      if (!task) return '';

      const st = new Date(seg.start);
      const en = new Date(seg.end);
      if (!isFinite(st.getTime()) || !isFinite(en.getTime()) || en <= st) return '';

      const durH = (en - st) / HOUR_MS;

      const startH = st.getHours() + st.getMinutes() / 60 + st.getSeconds() / 3600;
      const top = (startH - workStart) * hourHeight;
      const height = durH * hourHeight;

      const isCurrent = now.getTime() >= st.getTime() && now.getTime() < en.getTime();
      const isPastDeadline = typeof seg.pastDeadline === 'boolean'
        ? seg.pastDeadline
        : en.getTime() > new Date(task.deadline).getTime();
      const compact = height < 92;
      const progress = isCurrent ? clamp((now.getTime() - st.getTime()) / Math.max(1, en.getTime() - st.getTime()), 0, 1) : 0;
      const showTopEdge = seg.showTopEdge !== false;
      const showBottomEdge = seg.showBottomEdge !== false;

      const cls = [
        isCurrent ? 'current' : '',
        isPastDeadline ? 'pastDeadline' : '',
        compact ? 'compact' : ''
      ].filter(Boolean).join(' ');

      return `
        <div class="taskBlock ${cls}" style="top:${top}px; height:${height}px;" onclick="openTaskQuick('${escapeAttr(seg.taskId)}')">
          ${showTopEdge ? `<div class="taskEdge top" onclick="event.stopPropagation(); createBreakAtEdge('${escapeAttr(seg.start)}', true);"></div>` : ''}
          ${isCurrent ? `
            <div class="taskProgress">
              <div class="taskProgressFill" style="height:${progress * 100}%;"></div>
              <div class="taskProgressLine" style="top:${progress * 100}%;"></div>
            </div>
          ` : ''}
          <div class="taskContent">
            <div class="taskTitle">
              <span>${escapeHtml(task.name)}</span>
            </div>
            <div class="taskMeta">
              <span>${formatTimeRange(st, en)}</span>
            </div>
            <div class="taskActionsRow">
              <button class="taskAction ok" onclick="event.stopPropagation(); completeTask('${escapeAttr(task.id)}')">Completed</button>
              <button class="taskAction" onclick="event.stopPropagation(); openPartialComplete('${escapeAttr(task.id)}')">Partially</button>
              <button class="taskAction" onclick="event.stopPropagation(); openEditTask('${escapeAttr(task.id)}')">Change</button>
              <button class="taskAction danger" onclick="event.stopPropagation(); deleteTask('${escapeAttr(task.id)}')">Delete</button>
            </div>
          </div>
          ${showBottomEdge ? `<div class="taskEdge bottom" onclick="event.stopPropagation(); createBreakAtEdge('${escapeAttr(seg.end)}', false);"></div>` : ''}
        </div>
      `;
    }

    function renderBreak(br, workStart, hourHeight){
      const st = new Date(br.start);
      const en = new Date(br.end);
      if (!isFinite(st.getTime()) || !isFinite(en.getTime()) || en <= st) return '';

      const durH = (en - st) / HOUR_MS;

      const startH = st.getHours() + st.getMinutes() / 60;
      const top = (startH - workStart) * hourHeight;
      const height = durH * hourHeight;
      const compactBreak = height < 52;

      return `
        <div class="breakBlock ${compactBreak ? 'compact' : ''}" style="top:${top}px; height:${height}px;" data-break-id="${escapeAttr(br.breakId)}">
          <div class="resizeHandle top" onmousedown="startResizeBreak(event, '${escapeAttr(br.breakId)}', true)"></div>
          <div class="breakLabel">Break</div>
          <div class="removeBreak" onclick="removeBreak('${escapeAttr(br.breakId)}')">x</div>
          <div class="resizeHandle bottom" onmousedown="startResizeBreak(event, '${escapeAttr(br.breakId)}', false)"></div>
        </div>
      `;
    }

    function renderTimeLine(now, workStart, workEnd, hourHeight){
      const h = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
      if (h < workStart || h > workEnd) return '';

      const top = 44 + (h - workStart) * hourHeight;
      const label = `NOW ${formatTimeShort(now)}`;
      return `<div class="timeLine" data-now-label="${escapeAttr(label)}" style="top:${top}px;"></div>`;
    }

    function getWorkWindowForDay(day, settings){
      const dayStart = startOfDay(day);
      const workStartMin = parseTimeMinutes(settings.workStart);
      const workEndMin = parseTimeMinutes(settings.workEnd);

      return {
        startMs: dayStart.getTime() + (workStartMin * MIN_MS),
        endMs: dayStart.getTime() + (workEndMin * MIN_MS)
      };
    }

    function clipSegmentToWindow(seg, windowStartMs, windowEndMs){
      const segStart = new Date(seg.start).getTime();
      const segEnd = new Date(seg.end).getTime();
      if (!isFinite(segStart) || !isFinite(segEnd)) return null;

      const clippedStart = Math.max(segStart, windowStartMs);
      const clippedEnd = Math.min(segEnd, windowEndMs);
      if (clippedEnd <= clippedStart) return null;

      return {
        taskId: seg.taskId,
        start: getIso(new Date(clippedStart)),
        end: getIso(new Date(clippedEnd)),
        startMs: clippedStart,
        endMs: clippedEnd
      };
    }

    function clipBreakToWindow(br, windowStartMs, windowEndMs){
      const breakStart = new Date(br.start).getTime();
      const breakEnd = new Date(br.end).getTime();
      if (!isFinite(breakStart) || !isFinite(breakEnd)) return null;

      const clippedStart = Math.max(breakStart, windowStartMs);
      const clippedEnd = Math.min(breakEnd, windowEndMs);
      if (clippedEnd <= clippedStart) return null;

      return {
        breakId: br.breakId,
        start: getIso(new Date(clippedStart)),
        end: getIso(new Date(clippedEnd)),
        startMs: clippedStart,
        endMs: clippedEnd
      };
    }

    function splitSegmentByDeadline(seg, task){
      const startMs = new Date(seg.start).getTime();
      const endMs = new Date(seg.end).getTime();
      const deadlineMs = new Date(task.deadline).getTime();

      if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs){
        return [];
      }

      if (isFinite(deadlineMs) && deadlineMs > startMs && deadlineMs < endMs){
        const splitKey = `${task.id}|${startMs}|${endMs}|${deadlineMs}`;
        if (!splitLogMemo.has(splitKey)){
          splitLogMemo.add(splitKey);
          debugLog('deadline_split', {
            taskId: task.id,
            taskName: task.name,
            segmentStart: new Date(startMs).toISOString(),
            deadline: new Date(deadlineMs).toISOString(),
            segmentEnd: new Date(endMs).toISOString()
          });
        }
        return [
          {
            taskId: seg.taskId,
            start: getIso(new Date(startMs)),
            end: getIso(new Date(deadlineMs)),
            showTopEdge: true,
            showBottomEdge: false,
            pastDeadline: false
          },
          {
            taskId: seg.taskId,
            start: getIso(new Date(deadlineMs)),
            end: getIso(new Date(endMs)),
            showTopEdge: false,
            showBottomEdge: true,
            pastDeadline: true
          }
        ];
      }

      return [{
        taskId: seg.taskId,
        start: getIso(new Date(startMs)),
        end: getIso(new Date(endMs)),
        showTopEdge: true,
        showBottomEdge: true,
        pastDeadline: isFinite(deadlineMs) ? endMs > deadlineMs : false
      }];
    }

    // ------------------------------
    // Break creation and management
    // ------------------------------
    window.createBreakAtEdge = function(a, b, c){
      const edgeTime = (typeof c === 'undefined') ? a : b;

      const edgeDate = new Date(edgeTime);
      if (!isFinite(edgeDate.getTime())) return;

      const breakStart = new Date(edgeDate.getTime());
      const breakEnd = new Date(edgeDate.getTime() + 30 * MIN_MS);

      const clamped = clampBreakToWorkday(breakStart, breakEnd, state.settings);
      if (!clamped) return;

      state.breaks.push({
        breakId: uid(),
        start: getIso(clamped.start),
        end: getIso(clamped.end)
      });

      rebuildSchedule('break created');
    };

    window.createBreakAtConnector = function(atIso){
      const at = new Date(atIso);
      if (!isFinite(at.getTime())) return;

      const breakStart = new Date(at.getTime() - 15 * MIN_MS);
      const breakEnd = new Date(at.getTime() + 15 * MIN_MS);
      const clamped = clampBreakToWorkday(breakStart, breakEnd, state.settings);
      if (!clamped) return;

      state.breaks.push({
        breakId: uid(),
        start: getIso(clamped.start),
        end: getIso(clamped.end)
      });

      rebuildSchedule('break connector created');
    };

    function clampBreakToWorkday(start, end, settings){
      if (end <= start) return null;

      const cfg = settings || DEFAULT_SETTINGS;
      const [wsh, wsm] = cfg.workStart.split(':').map(Number);
      const [weh, wem] = cfg.workEnd.split(':').map(Number);

      const day = new Date(start);
      day.setHours(0, 0, 0, 0);

      const dayStart = new Date(day);
      dayStart.setHours(wsh, wsm, 0, 0);

      const dayEnd = new Date(day);
      dayEnd.setHours(weh, wem, 0, 0);

      const s = new Date(Math.max(start.getTime(), dayStart.getTime()));
      const e = new Date(Math.min(end.getTime(), dayEnd.getTime()));

      if (e.getTime() - s.getTime() < MIN_BREAK_MS){
        const maybeEnd = new Date(s.getTime() + MIN_BREAK_MS);
        if (maybeEnd <= dayEnd) return { start: s, end: maybeEnd };
        const maybeStart = new Date(e.getTime() - MIN_BREAK_MS);
        if (maybeStart >= dayStart) return { start: maybeStart, end: e };
        return null;
      }

      return { start: s, end: e };
    }

    function normalizeBreakCollection(breaks, settings){
      const normalized = [];

      for (const br of breaks || []){
        if (!br || !br.start || !br.end) continue;
        const bs = new Date(br.start);
        const be = new Date(br.end);
        if (!isFinite(bs.getTime()) || !isFinite(be.getTime())) continue;

        const clamped = clampBreakToWorkday(bs, be, settings);
        if (!clamped) continue;

        normalized.push({
          breakId: String(br.breakId || br.id || uid()),
          start: getIso(clamped.start),
          end: getIso(clamped.end)
        });
      }

      normalized.sort((a, b) => new Date(a.start) - new Date(b.start));
      return normalized;
    }

    window.removeBreak = function(breakId){
      state.breaks = state.breaks.filter(br => br.breakId !== breakId);
      rebuildSchedule('break removed');
    };

    let resizingBreak = null;
    let resizeIsTop = false;
    let resizeStartY = 0;
    let resizeStartTime = 0;

    window.startResizeBreak = function(e, breakId, isTop){
      e.preventDefault();
      e.stopPropagation();

      const br = state.breaks.find(b => b.breakId === breakId);
      if (!br) return;

      resizingBreak = breakId;
      resizeIsTop = isTop;
      resizeStartY = e.clientY;
      resizeStartTime = new Date(isTop ? br.start : br.end).getTime();

      document.addEventListener('mousemove', handleResizeBreak);
      document.addEventListener('mouseup', stopResizeBreak);
    };

    function handleResizeBreak(e){
      if (!resizingBreak) return;

      const deltaY = e.clientY - resizeStartY;
      const hourHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hourHeight') || '84');
      const deltaMs = (deltaY / hourHeight) * HOUR_MS;

      const newTime = resizeStartTime + deltaMs;
      const br = state.breaks.find(b => b.breakId === resizingBreak);
      if (!br) return;

      const day = new Date(br.start);
      day.setHours(0, 0, 0, 0);

      const [wsh, wsm] = state.settings.workStart.split(':').map(Number);
      const [weh, wem] = state.settings.workEnd.split(':').map(Number);

      const dayStart = new Date(day);
      dayStart.setHours(wsh, wsm, 0, 0);

      const dayEnd = new Date(day);
      dayEnd.setHours(weh, wem, 0, 0);

      if (resizeIsTop){
        const endTime = new Date(br.end).getTime();
        const candidate = Math.max(dayStart.getTime(), Math.min(newTime, endTime - MIN_BREAK_MS));
        br.start = getIso(new Date(candidate));
      } else {
        const startTime = new Date(br.start).getTime();
        const candidate = Math.min(dayEnd.getTime(), Math.max(newTime, startTime + MIN_BREAK_MS));
        br.end = getIso(new Date(candidate));
      }

      render();
    }

    function stopResizeBreak(){
      if (resizingBreak){
        rebuildSchedule('break resized');
        resizingBreak = null;
      }
      document.removeEventListener('mousemove', handleResizeBreak);
      document.removeEventListener('mouseup', stopResizeBreak);
    }

    // ------------------------------
    // Task modals
    // ------------------------------
    window.openNewTask = function(){
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24*HOUR_MS);

      openModal('New task', `
        <div>
          <label>Task name</label>
          <input type="text" id="name" placeholder="e.g. Write report" />
        </div>

        <div class="divider"></div>

        <div class="grid2">
          <div>
            <label>Estimate (hours)</label>
            <input type="number" id="estimate" value="1" min="0.1" step="0.1" />
          </div>
          <div>
            <label>Deadline</label>
            <input type="datetime-local" id="deadline" value="${formatInputDate(tomorrow)}" />
          </div>
        </div>

        <div class="divider"></div>

        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button class="btn" id="cancel">Cancel</button>
          <button class="btn primary" id="save">Create task</button>
        </div>
      `, el => {
        el.querySelector('#cancel').onclick = closeModal;
        el.querySelector('#save').onclick = () => {
          const name = el.querySelector('#name').value.trim();
          const estimate = parseFloat(el.querySelector('#estimate').value);
          const deadline = el.querySelector('#deadline').value;

          if (!name){
            alert('Please enter a task name.');
            return;
          }
          if (!estimate || estimate <= 0){
            alert('Please enter a valid estimate.');
            return;
          }
          if (!deadline){
            alert('Please select a deadline.');
            return;
          }

          const task = {
            id: uid(),
            name,
            createdAt: getIso(new Date()),
            deadline: new Date(deadline).toISOString(),
            initialEstimateMs: estimate * HOUR_MS,
            estimateMs: estimate * HOUR_MS,
            loggedMs: 0,
            status: 'active'
          };

          state.tasks.push(task);
          saveState(state, 'task:new');
          rebuildSchedule('new task');
          closeModal();
        };
      });
    };

    window.openEditTask = function(taskId){
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      const estimateH = task.estimateMs / HOUR_MS;
      const loggedH = task.loggedMs / HOUR_MS;
      const remaining = Math.max(0, task.estimateMs - task.loggedMs);
      const remainingH = remaining / HOUR_MS;

      openModal('Edit task', `
        <div>
          <label>Task name</label>
          <input type="text" id="name" value="${escapeAttr(task.name)}" />
        </div>

        <div class="divider"></div>

        <div class="grid2">
          <div>
            <label>Estimate (hours)</label>
            <input type="number" id="estimate" value="${estimateH}" min="0.1" step="0.1" />
          </div>
          <div>
            <label>Deadline</label>
            <input type="datetime-local" id="deadline" value="${formatInputDate(new Date(task.deadline))}" />
          </div>
        </div>

        <div class="divider"></div>

        <div>
          <label>Logged (hours)</label>
          <input type="number" id="logged" value="${loggedH.toFixed(2)}" min="0" step="0.1" />
          <div class="inlineSmall" style="margin-top:8px;">Track time spent on this task.</div>
        </div>

        <div class="divider"></div>

        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <button class="btn danger" id="delete">Delete task</button>
          <div style="display:flex; gap:10px;">
            <button class="btn" id="cancel">Cancel</button>
            <button class="btn primary" id="save">Save changes</button>
          </div>
        </div>
      `, el => {
        el.querySelector('#cancel').onclick = closeModal;

        el.querySelector('#delete').onclick = () => {
          deleteTask(taskId);
        };

        el.querySelector('#save').onclick = () => {
          const name = el.querySelector('#name').value.trim();
          const estimate = parseFloat(el.querySelector('#estimate').value);
          const deadline = el.querySelector('#deadline').value;
          const logged = parseFloat(el.querySelector('#logged').value);

          if (!name){
            alert('Please enter a task name.');
            return;
          }
          if (!estimate || estimate <= 0){
            alert('Please enter a valid estimate.');
            return;
          }
          if (!deadline){
            alert('Please select a deadline.');
            return;
          }
          if (logged < 0){
            alert('Logged time cannot be negative.');
            return;
          }

          task.name = name;
          task.estimateMs = estimate * HOUR_MS;
          task.deadline = new Date(deadline).toISOString();
          task.loggedMs = logged * HOUR_MS;
          task.lastEditedAt = getIso(new Date());

          saveState(state, 'task:edit');
          rebuildSchedule('task edited');
          closeModal();
        };
      });
    };

    window.openTaskQuick = function(taskId){
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      const now = new Date();
      const actualMs = getTaskActualMs(task, now);

      openModal('Task', `
        <div class="taskItem">
          <div class="taskItemTop">
            <div class="taskItemName">${escapeHtml(task.name)}</div>
            <div class="chip">${task.status === 'active' ? 'ACTIVE' : 'DONE'}</div>
          </div>
          <div class="taskItemMeta">
            <span>Initial: ${formatDurationMs(task.initialEstimateMs)}</span>
            <span>Estimate: ${formatDurationMs(task.estimateMs)}</span>
            <span>Logged: ${formatDurationMs(task.loggedMs)}</span>
            <span>Actual time: ${formatDurationMs(actualMs)}</span>
          </div>
        </div>
        <div class="divider"></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${task.status === 'active'
            ? `<button class="btn" id="complete">Completed</button>`
            : `<button class="btn" id="reopen">Reopen</button>`}
          <button class="btn" id="partial">Partially completed</button>
          <button class="btn" id="change">Change parameters</button>
          <button class="btn danger" id="delete">Delete</button>
        </div>
      `, body => {
        const completeBtn = body.querySelector('#complete');
        if (completeBtn) completeBtn.onclick = () => completeTask(task.id);
        const reopenBtn = body.querySelector('#reopen');
        if (reopenBtn) reopenBtn.onclick = () => reopenTask(task.id);
        body.querySelector('#partial').onclick = () => {
          closeModal();
          openPartialComplete(task.id);
        };
        body.querySelector('#change').onclick = () => {
          closeModal();
          openEditTask(task.id);
        };
        body.querySelector('#delete').onclick = () => deleteTask(task.id);
      });
    };

    window.openTaskList = function(){
      const now = new Date();
      const ordered = state.tasks.slice().sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        return new Date(a.deadline) - new Date(b.deadline);
      });

      openModal('Full task list', `
        ${ordered.length === 0 ? `
          <div class="emptyState">
            <div class="emptyText">No tasks yet.</div>
          </div>
        ` : `
          <div class="taskList">
            ${ordered.map(task => `
              <div class="taskItem">
                <div class="taskItemTop">
                  <div class="taskItemName">${escapeHtml(task.name)}</div>
                  <div class="chip">${task.status === 'active' ? 'ACTIVE' : 'DONE'}</div>
                </div>
                <div class="taskItemMeta">
                  <span>Initial duration: ${formatDurationMs(task.initialEstimateMs)}</span>
                  <span>Logged: ${formatDurationMs(task.loggedMs)}</span>
                  <span>Actual time: ${formatDurationMs(getTaskActualMs(task, now))}</span>
                  <span>Deadline: ${formatDateTimeNice(new Date(task.deadline))}</span>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
                  ${task.status === 'active'
                    ? `<button class="btn" onclick="completeTask('${escapeAttr(task.id)}')">Completed</button>`
                    : `<button class="btn" onclick="reopenTask('${escapeAttr(task.id)}')">Reopen</button>`}
                  <button class="btn" onclick="openPartialComplete('${escapeAttr(task.id)}')">Partially completed</button>
                  <button class="btn" onclick="openEditTask('${escapeAttr(task.id)}')">Change parameters</button>
                  <button class="btn danger" onclick="deleteTask('${escapeAttr(task.id)}')">Delete</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      `);
    };

    function completeTask(taskId){
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      if (runtime.activeTaskId === task.id){
        commitActiveRuntime(new Date());
      }

      task.loggedMs = Math.max(task.loggedMs, task.estimateMs);
      task.status = 'done';
      task.completedAt = getIso(new Date());

      closeModal();
      rebuildSchedule('task completed');
    }
    window.completeTask = completeTask;

    function reopenTask(taskId){
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      task.status = 'active';
      task.completedAt = undefined;
      closeModal();
      rebuildSchedule('task reopened');
    }
    window.reopenTask = reopenTask;

    window.openPartialComplete = function(taskId){
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      openModal('Partially completed', `
        <div class="grid2">
          <div>
            <label>Hours</label>
            <input type="number" id="hours" value="0" min="0" step="1" />
          </div>
          <div>
            <label>Minutes</label>
            <input type="number" id="minutes" value="30" min="0" max="59" step="1" />
          </div>
        </div>
        <div class="divider"></div>
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button class="btn" id="cancel">Cancel</button>
          <button class="btn primary" id="save">Save</button>
        </div>
      `, body => {
        body.querySelector('#cancel').onclick = closeModal;
        body.querySelector('#save').onclick = () => {
          const h = Number(body.querySelector('#hours').value || 0);
          const m = Number(body.querySelector('#minutes').value || 0);
          const addMs = ((Math.max(0, h) * 60) + Math.max(0, m)) * MIN_MS;
          if (addMs <= 0){
            alert('Please enter a positive time amount.');
            return;
          }

          if (runtime.activeTaskId === task.id){
            commitActiveRuntime(new Date());
          }

          task.loggedMs += addMs;
          task.actualMs = (Number(task.actualMs) || 0) + addMs;

          if (task.loggedMs >= task.estimateMs){
            task.status = 'done';
            task.completedAt = getIso(new Date());
          }

          closeModal();
          rebuildSchedule('task partial complete');
        };
      });
    };

    function deleteTask(taskId){
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      if (!confirm(`Delete "${task.name}"? This cannot be undone.`)) return;

      state.tasks = state.tasks.filter(t => t.id !== taskId);
      state.schedule = state.schedule.filter(seg => seg.taskId !== taskId);

      if (runtime.activeTaskId === task.id){
        runtime.activeTaskId = null;
        runtime.activeStartedAt = null;
      }

      closeModal();
      rebuildSchedule('task deleted');
    }
    window.deleteTask = deleteTask;

    // ------------------------------
    // Settings modal
    // ------------------------------
    window.openSettings = function(){
      const TABS = [
        { key: 'work', label: 'Work schedule' },
        { key: 'data', label: 'Import/Export' }
      ];

      let current = 'work';
      const root = document.createElement('div');

      function renderWork(){
        const s = state.settings;
        root.innerHTML = `
          <div class="hintBox">
            Define when you work each day and how many hours you can schedule daily. The planner uses these rules to fit tasks into your calendar.
          </div>

          <div class="divider"></div>

          <div class="grid2">
            <div>
              <label>Max hours per day</label>
              <input type="number" id="maxH" value="${s.maxHoursPerDay}" min="0" max="24" step="0.5" />
              <div class="inlineSmall" style="margin-top:8px;">Maximum hours to schedule each workday.</div>
            </div>
            <div>
              <label>&nbsp;</label>
              <div class="hintBox">Adjust this if you want more or less packed days.</div>
            </div>
          </div>

          <div class="divider"></div>

          <div class="grid2">
            <div>
              <label>Work start</label>
              <input type="time" id="ws" value="${s.workStart}" />
            </div>
            <div>
              <label>Work end</label>
              <input type="time" id="we" value="${s.workEnd}" />
            </div>
          </div>
          <div class="inlineSmall" style="margin-top:8px;">Tasks are scheduled between these hours.</div>

          <div class="divider"></div>

          <div>
            <label>Workdays</label>
            <div class="row" style="gap:8px; flex-wrap:wrap;">
              ${renderWorkDayCheckboxes(s.workDays)}
            </div>
            <div class="inlineSmall" style="margin-top:8px;">Scheduling starts from the next available slot based on these rules.</div>
          </div>

          <div class="divider"></div>

          <div class="grid2">
            <div>
              <label>Scheduling step (minutes)</label>
              <select id="step">
                ${[1,5,10,15,30].map(v=>`<option value="${v}" ${v===s.timeStepMin?'selected':''}>${v} min</option>`).join('')}
              </select>
              <div class="inlineSmall" style="margin-top:8px;">Smaller step = more precise placements (slightly more segments).</div>
            </div>
            <div>
              <label>&nbsp;</label>
              <div class="hintBox">After saving, the planner recalculates instantly.</div>
            </div>
          </div>

          <div class="divider"></div>

          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <button class="btn danger" id="reset">Reset all data</button>
            <div style="display:flex; gap:10px;">
              <button class="btn" id="cancel">Close</button>
              <button class="btn primary" id="save">Save settings</button>
            </div>
          </div>
        `;

        root.querySelector('#cancel').onclick = closeModal;

        root.querySelector('#reset').onclick = () => {
          if (!confirm('Reset everything? This clears tasks, schedule and settings.')) return;
          clearStoredState();
          state = loadState(true);
          runtime.activeTaskId = null;
          runtime.activeStartedAt = null;
          closeModal();
          rebuildSchedule('reset all');
        };

        root.querySelector('#save').onclick = () => {
          const maxH = Number(root.querySelector('#maxH').value);
          const ws = root.querySelector('#ws').value;
          const we = root.querySelector('#we').value;
          const step = Number(root.querySelector('#step').value);

          if (!ws || !we){
            alert('Please set work start and end.');
            return;
          }

          const days = [];
          for (let i=0;i<7;i++){
            days.push(!!root.querySelector(`#wd${i}`).checked);
          }

          state.settings.maxHoursPerDay = isFinite(maxH) ? clamp(maxH, 0, 24) : state.settings.maxHoursPerDay;
          state.settings.workStart = ws;
          state.settings.workEnd = we;
          state.settings.workDays = days;
          state.settings.timeStepMin = isFinite(step) ? step : state.settings.timeStepMin;

          saveState(state, 'settings:save');
          rebuildSchedule('settings saved');
          closeModal();
        };
      }

      function renderData(){
        root.innerHTML = `
          <div class="hintBox">
            <b>Export</b> saves your tasks, settings and schedule to a JSON file.<br>
            <b>Import</b> loads a JSON you previously exported.
          </div>

          <div class="divider"></div>

          <div class="grid2">
            <div>
              <label>Export</label>
              <button class="btn primary" id="export">Export JSON</button>
              <div class="inlineSmall" style="margin-top:8px;">Download a backup of everything.</div>
            </div>
            <div>
              <label>Import</label>
              <input id="import" type="file" accept="application/json" />
              <div class="inlineSmall" style="margin-top:8px;">Import replaces your current data.</div>
            </div>
          </div>

          <div class="divider"></div>

          <div style="display:flex; justify-content:flex-end; gap:10px;">
            <button class="btn" id="close">Close</button>
          </div>
        `;

        root.querySelector('#close').onclick = closeModal;

        root.querySelector('#export').onclick = () => {
          const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          const stamp = new Date();
          a.href = URL.createObjectURL(blob);
          a.download = `weekly-scheduler-backup-${formatDateFile(stamp)}-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
        };

        root.querySelector('#import').onchange = async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;

          try{
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data || !data.settings || !Array.isArray(data.tasks)) throw new Error('Invalid file');

            if (!confirm('Import will REPLACE your current data. Continue?')) return;

            state = sanitizeState(data);
            runtime.activeTaskId = null;
            runtime.activeStartedAt = null;
            saveState(state, 'data:import');
            rebuildSchedule('import');
            closeModal();
          }catch(err){
            alert('Could not import: ' + (err && err.message ? err.message : String(err)));
          }
        };
      }

      function openWith(tabKey){
        current = tabKey;
        const tabDefs = TABS.map(t => ({
          label: t.label,
          active: t.key === current,
          onClick: () => openWith(t.key)
        }));

        if (current === 'work') renderWork();
        if (current === 'data') renderData();

        if (modalStack.length > 0){
          const top = modalStack.pop();
          top.remove();
        }

        openModal('Settings', root, { tabs: tabDefs });
      }

      openWith('work');
    };

    function renderWorkDayCheckboxes(days){
      const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      return labels.map((lab,i)=>{
        const checked = days[i] ? 'checked' : '';
        return `
          <label style="display:flex; align-items:center; gap:8px; font-weight:800; font-size:12px; border:1px solid var(--border); background:#fff; padding:8px 10px; border-radius:999px; margin:0; cursor:pointer;">
            <input id="wd${i}" type="checkbox" ${checked} style="width:auto;" />
            ${lab}
          </label>
        `;
      }).join('');
    }

    // ------------------------------
    // Modal system
    // ------------------------------
    function openModal(title, body, opts = {}){
      if (typeof opts === 'function'){
        opts = { onOpen: opts };
      }

      const overlay = document.createElement('div');
      overlay.className = 'modal';

      const box = document.createElement('div');
      box.className = 'modalBox';

      let tabsHtml = '';
      if (opts.tabs && opts.tabs.length){
        tabsHtml = `<div class="modalTabs">${opts.tabs.map(t => `
          <button class="modalTab ${t.active?'active':''}" data-tab="${escapeAttr(t.label)}">${escapeHtml(t.label)}</button>
        `).join('')}</div>`;
      }

      box.innerHTML = `
        <div class="modalHeader">
          <h2>${escapeHtml(title)}</h2>
          <button class="modalClose">x</button>
        </div>
        ${tabsHtml}
        <div class="modalBody"></div>
      `;

      const bodyEl = box.querySelector('.modalBody');
      if (typeof body === 'string'){
        bodyEl.innerHTML = body;
      } else {
        bodyEl.appendChild(body);
      }

      if (opts.tabs){
        opts.tabs.forEach(t => {
          const btn = box.querySelector(`[data-tab="${escapeAttr(t.label)}"]`);
          if (btn && t.onClick){
            btn.onclick = t.onClick;
          }
        });
      }

      box.querySelector('.modalClose').onclick = closeModal;
      overlay.onclick = e => {
        if (e.target === overlay) closeModal();
      };

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      modalStack.push(overlay);

      if (opts.onOpen) opts.onOpen(bodyEl);
    }

    function closeModal(){
      if (modalStack.length === 0) return;
      const top = modalStack.pop();
      top.remove();
      render();
    }

    window.closeModal = closeModal;

    // ------------------------------
    // Scheduling
    // ------------------------------
    function rebuildSchedule(reason, shouldRender = true){
      const activeTasks = state.tasks.filter(t => t.status === 'active');
      splitLogMemo.clear();
      debugLog('rebuild_start', {
        reason,
        activeTasks: activeTasks.length,
        breaks: (state.breaks || []).length,
        stepMin: state.settings.timeStepMin
      });
      state.breaks = normalizeBreakCollection(state.breaks, state.settings);
      state.schedule = buildSchedule(new Date(), activeTasks, state.settings, state.breaks);
      state.lastScheduledAt = getIso(new Date());
      syncActiveRuntime(new Date());
      debugLog('rebuild_done', { reason, segments: state.schedule.length, breaks: state.breaks.length });
      saveState(state, `rebuild:${reason}`);
      if (shouldRender) render();
    }

    function buildSchedule(now, tasks, settings, breaks){
      const sorted = tasks.slice().sort((a, b) => {
        const da = new Date(a.deadline);
        const db = new Date(b.deadline);
        return da - db;
      });
      const normalizedBreaks = normalizeBreakCollection(breaks, settings);

      const stepMs = (settings.timeStepMin || 15) * MIN_MS;

      const [wsh, wsm] = settings.workStart.split(':').map(Number);
      const [weh, wem] = settings.workEnd.split(':').map(Number);
      const workStartMin = (wsh * 60) + wsm;
      const workEndMin = (weh * 60) + wem;

      const maxDayMs = Math.min(settings.maxHoursPerDay * HOUR_MS, Math.max(0, (workEndMin - workStartMin) * MIN_MS));

      const latestDeadline = sorted.reduce((max, task) => Math.max(max, new Date(task.deadline).getTime()), now.getTime());
      const horizonDays = clamp(Math.ceil((latestDeadline - now.getTime()) / DAY_MS) + 30, 21, 365);

      const freeSlots = [];
      const startDay = startOfDay(now);

      for (let i = 0; i < horizonDays; i++){
        const day = addDays(startDay, i);
        const wd = (day.getDay() + 6) % 7;
        if (!settings.workDays[wd]) continue;

        const dayStart = new Date(day);
        dayStart.setHours(0, 0, 0, 0);
        dayStart.setMinutes(workStartMin);

        const dayEnd = new Date(day);
        dayEnd.setHours(0, 0, 0, 0);
        dayEnd.setMinutes(workEndMin);

        let cursor = Math.max(dayStart.getTime(), now.getTime());
        cursor = ceilToStep(cursor, stepMs);
        if (cursor >= dayEnd.getTime()) continue;

        const daySlots = [];
        while (cursor < dayEnd.getTime()){
          const slotEnd = Math.min(cursor + stepMs, dayEnd.getTime());
          if (!overlapsBreak(cursor, slotEnd, normalizedBreaks)){
            daySlots.push({ start: cursor, end: slotEnd });
          }
          cursor += stepMs;
        }

        let dayRemaining = maxDayMs;
        for (const slot of daySlots){
          if (dayRemaining <= 0) break;
          const chunk = Math.min(slot.end - slot.start, dayRemaining);
          if (chunk > 0){
            freeSlots.push({ start: slot.start, end: slot.start + chunk });
            dayRemaining -= chunk;
          }
        }
      }

      const result = [];
      let slotIdx = 0;

      for (const task of sorted){
        let remaining = Math.max(0, (task.estimateMs || 0) - (task.loggedMs || 0));

        while (remaining > 0 && slotIdx < freeSlots.length){
          const slot = freeSlots[slotIdx];
          const available = slot.end - slot.start;
          if (available <= 0){
            slotIdx += 1;
            continue;
          }

          const chunk = Math.min(available, remaining);
          result.push({
            taskId: task.id,
            start: getIso(new Date(slot.start)),
            end: getIso(new Date(slot.start + chunk))
          });

          slot.start += chunk;
          remaining -= chunk;

          if (slot.start >= slot.end - 1) slotIdx += 1;
        }
      }

      return mergeSegments(result);
    }

    function mergeSegments(segments){
      const sorted = segments.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
      const merged = [];

      for (const seg of sorted){
        const last = merged[merged.length - 1];
        if (!last){
          merged.push({ ...seg });
          continue;
        }

        const lastEnd = new Date(last.end).getTime();
        const curStart = new Date(seg.start).getTime();
        if (last.taskId === seg.taskId && Math.abs(lastEnd - curStart) <= 1000){
          last.end = seg.end;
        } else {
          merged.push({ ...seg });
        }
      }

      return merged;
    }

    function overlapsBreak(startMs, endMs, breaks){
      return breaks.some(br => {
        const bs = new Date(br.start).getTime();
        const be = new Date(br.end).getTime();
        if (!isFinite(bs) || !isFinite(be)) return false;
        return startMs < be && endMs > bs;
      });
    }

    function getCurrentSegment(now, segments){
      const nowMs = now.getTime();
      for (const seg of segments || []){
        const st = new Date(seg.start).getTime();
        const en = new Date(seg.end).getTime();
        if (nowMs >= st && nowMs < en) return seg;
      }
      return null;
    }

    function syncActiveRuntime(now){
      const seg = getCurrentSegment(now, state.schedule);
      const activeId = seg ? seg.taskId : null;
      let changed = false;

      if (runtime.activeTaskId && runtime.activeTaskId !== activeId){
        changed = commitActiveRuntime(now) || changed;
      }

      if (!activeId){
        if (runtime.activeTaskId){
          changed = commitActiveRuntime(now) || changed;
        }
        return changed;
      }

      if (!runtime.activeTaskId){
        runtime.activeTaskId = activeId;
        runtime.activeStartedAt = new Date(seg.start).getTime();
        return changed;
      }

      if (!runtime.activeStartedAt){
        runtime.activeStartedAt = new Date(seg.start).getTime();
      }

      return changed;
    }

    function commitActiveRuntime(now){
      if (!runtime.activeTaskId || !runtime.activeStartedAt){
        runtime.activeTaskId = null;
        runtime.activeStartedAt = null;
        return false;
      }

      const task = state.tasks.find(t => t.id === runtime.activeTaskId);
      if (!task){
        runtime.activeTaskId = null;
        runtime.activeStartedAt = null;
        return false;
      }

      const elapsed = Math.max(0, now.getTime() - runtime.activeStartedAt);
      task.actualMs = (Number(task.actualMs) || 0) + elapsed;

      runtime.activeTaskId = null;
      runtime.activeStartedAt = null;
      return elapsed > 0;
    }

    // ------------------------------
    // Time helpers
    // ------------------------------
    function startOfDay(d){
      const out = new Date(d);
      out.setHours(0, 0, 0, 0);
      return out;
    }

    function addDays(d, n){
      const out = new Date(d);
      out.setDate(d.getDate() + n);
      return out;
    }

    function isSameDay(a, b){
      return a.getFullYear() === b.getFullYear() &&
             a.getMonth() === b.getMonth() &&
             a.getDate() === b.getDate();
    }

    function formatTimeNice(d){
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    }

    function formatTimeShort(d){
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    }

    function formatTimeRange(a, b){
      return `${formatTimeNice(a)} - ${formatTimeNice(b)}`;
    }

    function formatDateNice(d){
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function formatDateTimeNice(d){
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function formatDateFile(d){
      return d.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '-');
    }

    function formatDayMonth(d){
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function formatHour(h){
      const hour12 = h % 12 || 12;
      const ampm = h < 12 ? 'AM' : 'PM';
      return `${hour12} ${ampm}`;
    }

    function formatInputDate(d){
      const pad = n => String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function getIso(d){
      return d.toISOString();
    }

    function pad2(n){
      return String(n).padStart(2,'0');
    }

    function uid(){
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }

    function clamp(val, min, max){
      return Math.min(Math.max(val, min), max);
    }

    function ceilToStep(ms, stepMs){
      return Math.ceil(ms / stepMs) * stepMs;
    }

    function parseTimeMinutes(v){
      const [h, m] = String(v || '').split(':').map(Number);
      return (h * 60) + m;
    }

    function formatDurationMs(ms){
      const totalMin = Math.round(ms / MIN_MS);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h > 0 && m > 0) return `${h}h ${m}m`;
      if (h > 0) return `${h}h`;
      return `${m}m`;
    }

    function getTaskActualMs(task, now){
      let ms = Number(task.actualMs) || 0;
      if (runtime.activeTaskId === task.id && runtime.activeStartedAt){
        ms += Math.max(0, now.getTime() - runtime.activeStartedAt);
      }
      return ms;
    }

    function debugLog(event, payload){
      if (!DEBUG) return;
      if (typeof payload === 'undefined'){
        console.log('[WeeklyScheduler debug]', event);
      } else {
        console.log('[WeeklyScheduler debug]', event, payload);
      }
    }

    function debugWarn(event, payload){
      if (!DEBUG) return;
      if (typeof payload === 'undefined'){
        console.error('[WeeklyScheduler debug]', event);
      } else {
        console.error('[WeeklyScheduler debug]', event, payload);
      }
    }

    // ------------------------------
    // Storage
    // ------------------------------
    function sanitizeState(raw){
      raw = raw || {};
      const s = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      if (!Array.isArray(s.workDays) || s.workDays.length !== 7) s.workDays = DEFAULT_SETTINGS.workDays.slice();
      s.maxHoursPerDay = clamp(Number(s.maxHoursPerDay) || DEFAULT_SETTINGS.maxHoursPerDay, 0, 24);
      s.workStart = typeof s.workStart === 'string' ? s.workStart : DEFAULT_SETTINGS.workStart;
      s.workEnd = typeof s.workEnd === 'string' ? s.workEnd : DEFAULT_SETTINGS.workEnd;
      s.timeStepMin = [1,5,10,15,30].includes(Number(s.timeStepMin)) ? Number(s.timeStepMin) : DEFAULT_SETTINGS.timeStepMin;

      const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
      const cleanTasks = tasks.map(t => ({
        id: String(t.id || uid()),
        name: String(t.name || 'Untitled task'),
        createdAt: t.createdAt || getIso(new Date()),
        deadline: t.deadline || getIso(new Date(Date.now() + 24*3600000)),
        initialEstimateMs: Number(t.initialEstimateMs)||Number(t.estimateMs)||3600000,
        estimateMs: Number(t.estimateMs)||3600000,
        loggedMs: Number(t.loggedMs)||0,
        actualMs: Number(t.actualMs)||0,
        status: (t.status === 'done' || t.status === 'archived') ? 'done' : 'active',
        completedAt: t.completedAt,
        lastProgressAt: t.lastProgressAt,
        lastEditedAt: t.lastEditedAt
      }));

      const schedule = Array.isArray(raw.schedule) ? raw.schedule : [];
      const cleanSchedule = schedule
        .filter(x => x && x.taskId && x.start && x.end)
        .map(x => ({ taskId: String(x.taskId), start: String(x.start), end: String(x.end) }));

      const breaks = Array.isArray(raw.breaks) ? raw.breaks : [];
      const cleanBreaks = normalizeBreakCollection(breaks
        .filter(x => x && x.start && x.end)
        .map(x => ({ breakId: String(x.breakId || x.id || uid()), start: String(x.start), end: String(x.end) })), s);

      return { settings: s, tasks: cleanTasks, schedule: cleanSchedule, breaks: cleanBreaks, lastScheduledAt: raw.lastScheduledAt };
    }

    function loadState(forceFresh=false){
      if (!forceFresh){
        let stage = 'init';
        let textForDebug = '';
        try{
          debugLog('load_attempt', { key: STORAGE_KEY, href: location.href });

          let loadedFrom = STORAGE_KEY;
          stage = 'read_primary';
          let text = localStorage.getItem(STORAGE_KEY);
          textForDebug = text || '';
          if (!text){
            stage = 'read_legacy';
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy){
              text = legacy;
              textForDebug = legacy;
              loadedFrom = LEGACY_STORAGE_KEY;
              localStorage.removeItem(LEGACY_STORAGE_KEY);
              debugLog('legacy_migrated_to_primary', { from: LEGACY_STORAGE_KEY, to: STORAGE_KEY, bytes: legacy.length });
            }
          }

          if (text){
            debugLog('load_found', { key: loadedFrom, bytes: text.length });
            stage = 'parse_json';
            const raw = JSON.parse(text);
            stage = 'sanitize_state';
            const cleaned = sanitizeState(raw);
            stage = 'rebuild_schedule';
            cleaned.schedule = buildSchedule(new Date(), cleaned.tasks.filter(t => t.status === 'active'), cleaned.settings, cleaned.breaks);
            cleaned.lastScheduledAt = getIso(new Date());
            stage = 'persist_cleaned';
            saveState(cleaned, `load:migrated_from:${loadedFrom}`);
            stage = 'log_success';
            debugLog('load_success', {
              key: STORAGE_KEY,
              tasks: cleaned.tasks.length,
              breaks: cleaned.breaks.length,
              schedule: cleaned.schedule.length
            });
            stage = 'return_cleaned';
            return cleaned;
          }
        }catch(e){
          debugWarn('load_failed', {
            stage,
            error: String((e && e.message) ? e.message : e),
            stack: e && e.stack ? String(e.stack) : '',
            textBytes: textForDebug ? textForDebug.length : 0,
            textPreview: textForDebug ? textForDebug.slice(0, 180) : ''
          });
        }
      }

      const fresh = { settings: { ...DEFAULT_SETTINGS }, tasks: [], schedule: [], breaks: [], lastScheduledAt: getIso(new Date()) };
      debugLog('load_fresh_state');
      saveState(fresh, 'load:fresh_state');
      return fresh;
    }

    function saveState(st, source = 'unknown'){
      try{
        const fullPayload = JSON.stringify(st);
        localStorage.setItem(STORAGE_KEY, fullPayload);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        debugLog('save_success_full', {
          source,
          key: STORAGE_KEY,
          bytes: fullPayload.length,
          tasks: (st.tasks || []).length,
          breaks: (st.breaks || []).length,
          schedule: (st.schedule || []).length
        });
      }catch(e){
        debugWarn('save_full_failed_retry_compact', {
          source,
          key: STORAGE_KEY,
          error: String((e && e.message) ? e.message : e)
        });
        try{
          const compact = {
            settings: st.settings,
            tasks: st.tasks,
            breaks: st.breaks,
            lastScheduledAt: st.lastScheduledAt,
            schedule: []
          };
          const compactPayload = JSON.stringify(compact);
          localStorage.setItem(STORAGE_KEY, compactPayload);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          debugWarn('save_compact_fallback_success', {
            source,
            key: STORAGE_KEY,
            bytes: compactPayload.length,
            tasks: (st.tasks || []).length,
            breaks: (st.breaks || []).length
          });
        }catch(e2){
          debugWarn('save_compact_failed', {
            source,
            key: STORAGE_KEY,
            error: String((e2 && e2.message) ? e2.message : e2)
          });
        }
      }
    }

    function clearStoredState(){
      try{
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }catch(e){
        // ignore
      }
    }

    // ------------------------------
    // Safe HTML
    // ------------------------------
    function escapeHtml(str){
      return String(str)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&#039;');
    }
    function escapeAttr(str){
      return escapeHtml(str).replaceAll('`','&#096;');
    }

  })();
