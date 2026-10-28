# In-memory fake of the Google Calendar API, served through Playwright request routing.
import json, re, itertools, urllib.parse
import expand_sections  # noqa: F401  (opens collapsed dialog sections for older tests)
class MockGoogle:
    def __init__(self, fail_insert=False):
        self.cals = {'primary': {'id': 'me@example.com', 'summary': 'me@example.com', 'primary': True, 'accessRole': 'owner', 'backgroundColor': '#039be5', 'timeZone': 'Europe/Berlin', 'defaultReminders': [{'method':'popup','minutes':10}]},
                     'work': {'id': 'work', 'summary': 'Work', 'accessRole': 'owner', 'backgroundColor': '#0b8043', 'timeZone': 'Europe/Berlin', 'defaultReminders': []}}
        self.events = {'me@example.com': {}, 'work': {}}
        self.seq = itertools.count(1)
        self.log = []
        self.fail_insert = fail_insert
        # fault injection / measurement for sync tests
        self.delay = 0            # seconds each request takes
        self.flaky_every = 0      # every Nth write answers 503 (temporary error) without doing anything
        self.rate_every = 0       # every Nth write answers 403 rateLimitExceeded
        self.lose_inserts = 0     # this many inserts answer "OK" but are never stored
        self.inflight = 0; self.max_inflight = 0; self.writes = 0
        self.lag_instances = 0    # after a change to one occurrence, list reads show the old one for this many seconds
        self._stale = 0; self._stale_ex = None
    # --- Google Drive app folder (backups)
    drive_files = None
    drive_denied = False
    async def drive(self, route, m, path, q):
        if self.drive_files is None: self.drive_files = {}
        def ok(obj, status=200): return route.fulfill(status=status, headers=self.cors(), content_type='application/json', body=json.dumps(obj))
        if self.drive_denied: return await ok({'error': {'code': 403, 'message': 'Request had insufficient authentication scopes.'}}, 403)
        mm = re.match(r'^/drive/v3/files/([^/]+)$', path)
        if m == 'GET' and path == '/drive/v3/files':
            files = sorted(self.drive_files.values(), key=lambda f: f['modifiedTime'], reverse=True)
            return await ok({'files': [{k: f[k] for k in ('id', 'name', 'modifiedTime', 'size')} for f in files]})
        if m == 'POST' and path == '/upload/drive/v3/files':
            raw = route.request.post_data or ''
            parts = [p for p in raw.split('\r\n\r\n')[1:]]
            meta = json.loads(parts[0].split('\r\n--')[0]); content = parts[1].split('\r\n--')[0]
            fid = f'f{next(self.seq)}'; n = len(self.drive_files)
            self.drive_files[fid] = {'id': fid, 'name': meta['name'], 'parents': meta.get('parents'), 'modifiedTime': f'2026-10-28T{8 + n // 60:02d}:{n % 60:02d}:00.000Z', 'size': str(len(content)), 'content': content}
            return await ok({k: self.drive_files[fid][k] for k in ('id', 'name', 'modifiedTime', 'size')})
        if mm and m == 'GET' and q.get('alt', [''])[0] == 'media':
            f = self.drive_files.get(mm.group(1))
            return await (route.fulfill(status=200, headers=self.cors(), content_type='application/json', body=f['content']) if f else ok({'error': {'message': 'Not Found'}}, 404))
        if mm and m == 'DELETE':
            self.drive_files.pop(mm.group(1), None); return await route.fulfill(status=204, headers=self.cors())
        return await ok({'error': {'message': 'unhandled drive ' + path}}, 404)
    def cal_id(self, c):
        c = urllib.parse.unquote(c)
        return 'me@example.com' if c == 'primary' else c
    async def handle(self, route):
        import asyncio
        self.inflight += 1; self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            if self.delay: await asyncio.sleep(self.delay)
            return await self._handle(route)
        finally:
            self.inflight -= 1
    async def _handle(self, route):
        req = route.request
        url = urllib.parse.urlparse(req.url); q = urllib.parse.parse_qs(url.query)
        path = url.path.replace('/calendar/v3', '')
        m = req.method
        if m == 'OPTIONS':
            return await route.fulfill(status=204, headers=self.cors())
        self.log.append(f'{m} {path}')
        if path.startswith('/drive/v3/files') or path.startswith('/upload/drive/v3/files'):
            return await self.drive(route, m, path, q)
        body = json.loads(req.post_data) if req.post_data else None
        def ok(obj, status=200): return route.fulfill(status=status, headers=self.cors(), content_type='application/json', body=json.dumps(obj))
        if path.startswith('/v1/userinfo') or 'userinfo' in path: return await ok({'email': 'me@example.com'})
        if path == '/users/me/calendarList': return await ok({'items': list(self.cals.values())})
        mcl = re.match(r'^/users/me/calendarList/([^/]+)$', path)
        if mcl and m == 'PATCH':
            cid = self.cal_id(mcl.group(1)); key = next((k for k, c in self.cals.items() if c['id'] == cid), None)
            if key is None: return await ok({'error': {'message': 'Not Found'}}, 404)
            self.cals[key].update(body); return await ok(self.cals[key])
        if path == '/users/me/settings/timezone': return await ok({'value': 'Europe/Berlin'})
        if path == '/calendars' and m == 'POST':
            cid = f'cal{next(self.seq)}@group'; self.cals[cid] = {'id': cid, 'summary': body['summary'], 'accessRole': 'owner', 'backgroundColor': '#8e24aa', 'defaultReminders': []}; self.events[cid] = {}
            return await ok({'id': cid, 'summary': body['summary']})
        mm = re.match(r'^/calendars/([^/]+)/events(?:/([^/]+))?$', path)
        if mm:
            cid = self.cal_id(mm.group(1)); eid = mm.group(2) and urllib.parse.unquote(mm.group(2))
            evs = self.events.setdefault(cid, {})
            if m == 'GET' and not eid:
                items = list(evs.values())
                if q.get('singleEvents', ['false'])[0] == 'true':
                    import time as _t
                    if self._stale > _t.time():
                        live = self.exceptions; self.exceptions = self._stale_ex
                        try: items = self.single_events(cid, items, q)
                        finally: self.exceptions = live
                    else: items = self.single_events(cid, items, q)
                if 'updatedMin' in q:
                    items = [e for e in items if e.get('updated', '') > q['updatedMin'][0]]
                if 'privateExtendedProperty' in q:
                    k, v = q['privateExtendedProperty'][0].split('=')
                    items = [e for e in items if e.get('extendedProperties', {}).get('private', {}).get(k) == v]
                return await ok({'items': items})
            inst = self.instance(cid, eid) if eid and eid not in evs else None
            if inst is not None:
                ex = self.exceptions.setdefault(cid, {})
                if m == 'GET': return await ok(inst)
                if m == 'PATCH':
                    if self.lag_instances:
                        import copy; import time as _t; self._stale_ex = copy.deepcopy(self.exceptions); self._stale = _t.time() + self.lag_instances
                    ex[eid] = {**inst, **body, 'updated': self.now()}; return await ok(ex[eid])
                if m == 'DELETE': ex[eid] = {**inst, 'status': 'cancelled'}; return await route.fulfill(status=204, headers=self.cors())
            if m == 'GET': return await (ok(evs[eid]) if eid in evs else ok({'error': {'message': 'Not Found'}}, 404))
            if m in ('POST', 'PATCH', 'DELETE'):
                self.writes += 1
                if self.flaky_every and self.writes % self.flaky_every == 0: return await ok({'error': {'code': 503, 'message': 'Backend Error'}}, 503)
                if self.rate_every and self.writes % self.rate_every == 0: return await ok({'error': {'code': 403, 'message': 'Rate Limit Exceeded', 'errors': [{'reason': 'rateLimitExceeded'}]}}, 403)
            if m == 'POST':
                if self.fail_insert: return await ok({'error': {'message': 'Insufficient Permission'}}, 403)
                eid = body.get('id') or f'ev{next(self.seq)}'
                if eid in evs: return await ok({'error': {'code': 409, 'message': 'The requested identifier already exists.'}}, 409)
                e = {**body, 'id': eid, 'status': 'confirmed', 'htmlLink': 'https://calendar.google.com/x', 'updated': self.now()}
                if self.lose_inserts > 0: self.lose_inserts -= 1; return await ok(e)   # claims success, stores nothing
                evs[eid] = e
                return await ok(e)
            if m == 'PATCH':
                if eid not in evs: return await ok({'error': {'message': 'Not Found'}}, 404)
                evs[eid].update(body); evs[eid]['updated'] = self.now(); return await ok(evs[eid])
            if m == 'DELETE':
                evs.pop(eid, None); return await route.fulfill(status=204, headers=self.cors())
        return await ok({'error': {'message': 'unhandled ' + path}}, 404)
    exceptions = None
    # --- recurring events: expansion (DAILY/WEEKLY with INTERVAL, COUNT, UNTIL, BYDAY) and per-instance exceptions
    def _occ(self, master):
        import datetime
        rule = next((l[6:] for l in master.get('recurrence', []) if l.startswith('RRULE:')), None)
        if not rule: return []
        r = dict(x.split('=') for x in rule.split(';'))
        st = datetime.datetime.fromisoformat(master['start']['dateTime'].replace('Z', '+00:00'))
        en = datetime.datetime.fromisoformat(master['end']['dateTime'].replace('Z', '+00:00'))
        step = int(r.get('INTERVAL', 1)); count = int(r['COUNT']) if 'COUNT' in r else 400
        until = None
        if 'UNTIL' in r:
            u = r['UNTIL']; until = datetime.datetime.strptime(u[:15] if 'T' in u else u + 'T235959', '%Y%m%dT%H%M%S').replace(tzinfo=datetime.timezone.utc)
        days = None
        if r.get('FREQ') == 'WEEKLY' and 'BYDAY' in r: days = [['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].index(d[-2:]) for d in r['BYDAY'].split(',')]
        out = []; d = st; n = 0; i = 0
        while n < count and i < 3000:
            i += 1
            ok = True
            if r.get('FREQ') == 'WEEKLY':
                weeks = (d.date() - st.date()).days // 7
                ok = weeks % step == 0 and ((d.weekday() in days) if days else d.weekday() == st.weekday())
            elif r.get('FREQ') == 'DAILY':
                ok = (d.date() - st.date()).days % step == 0
            if ok and d >= st:
                if until and d > until: break
                out.append((d, d + (en - st))); n += 1
            d += datetime.timedelta(days=1)
        return out
    def _inst(self, master, s, e):
        import datetime
        iid = master['id'] + '_' + s.astimezone(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        x = {k: v for k, v in master.items() if k != 'recurrence'}
        x.update({'id': iid, 'recurringEventId': master['id'], 'originalStartTime': {'dateTime': s.isoformat()}, 'start': {**master['start'], 'dateTime': s.isoformat()}, 'end': {**master['end'], 'dateTime': e.isoformat()}})
        return x
    def instance(self, cid, eid):
        import re as _re
        if self.exceptions is None: self.exceptions = {}
        ex = self.exceptions.setdefault(cid, {})
        if eid in ex: return ex[eid]
        mm = _re.match(r'^(.+)_(\d{8}T\d{6}Z)$', eid or '')
        if not mm or mm.group(1) not in self.events.get(cid, {}): return None
        master = self.events[cid][mm.group(1)]
        for s, e in self._occ(master):
            x = self._inst(master, s, e)
            if x['id'] == eid: return x
        return None
    def single_events(self, cid, items, q):
        import datetime
        if self.exceptions is None: self.exceptions = {}
        ex = self.exceptions.setdefault(cid, {})
        tmin = datetime.datetime.fromisoformat(q['timeMin'][0].replace('Z', '+00:00')) if 'timeMin' in q else None
        tmax = datetime.datetime.fromisoformat(q['timeMax'][0].replace('Z', '+00:00')) if 'timeMax' in q else None
        out = []
        for e in items:
            if not e.get('recurrence') or 'dateTime' not in e.get('start', {}): out.append(e); continue
            for s, en in self._occ(e):
                if (tmin and en <= tmin) or (tmax and s >= tmax): continue
                x = self._inst(e, s, en)
                if x['id'] in ex: continue
                out.append(x)
            out += [x for x in ex.values() if x.get('recurringEventId') == e['id'] and x.get('status') != 'cancelled']
        return out
    def now(self):
        import datetime
        return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=self.clock_offset)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    clock_offset = 0
    def cors(self): return {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}
    def task_events(self):
        return [e for evs in self.events.values() for e in evs.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoTask')]
