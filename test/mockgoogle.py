# In-memory fake of the Google Calendar API, served through Playwright request routing.
import json, re, itertools, urllib.parse
class MockGoogle:
    def __init__(self, fail_insert=False):
        self.cals = {'primary': {'id': 'me@example.com', 'summary': 'me@example.com', 'primary': True, 'accessRole': 'owner', 'backgroundColor': '#039be5', 'timeZone': 'Europe/Berlin', 'defaultReminders': [{'method':'popup','minutes':10}]},
                     'work': {'id': 'work', 'summary': 'Work', 'accessRole': 'owner', 'backgroundColor': '#0b8043', 'timeZone': 'Europe/Berlin', 'defaultReminders': []}}
        self.events = {'me@example.com': {}, 'work': {}}
        self.seq = itertools.count(1)
        self.log = []
        self.fail_insert = fail_insert
    def cal_id(self, c):
        c = urllib.parse.unquote(c)
        return 'me@example.com' if c == 'primary' else c
    async def handle(self, route):
        req = route.request
        url = urllib.parse.urlparse(req.url); q = urllib.parse.parse_qs(url.query)
        path = url.path.replace('/calendar/v3', '')
        m = req.method
        if m == 'OPTIONS':
            return await route.fulfill(status=204, headers=self.cors())
        self.log.append(f'{m} {path}')
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
                if 'updatedMin' in q:
                    items = [e for e in items if e.get('updated', '') > q['updatedMin'][0]]
                if 'privateExtendedProperty' in q:
                    k, v = q['privateExtendedProperty'][0].split('=')
                    items = [e for e in items if e.get('extendedProperties', {}).get('private', {}).get(k) == v]
                return await ok({'items': items})
            if m == 'GET': return await (ok(evs[eid]) if eid in evs else ok({'error': {'message': 'Not Found'}}, 404))
            if m == 'POST':
                if self.fail_insert: return await ok({'error': {'message': 'Insufficient Permission'}}, 403)
                eid = f'ev{next(self.seq)}'; e = {**body, 'id': eid, 'status': 'confirmed', 'htmlLink': 'https://calendar.google.com/x', 'updated': self.now()}; evs[eid] = e
                return await ok(e)
            if m == 'PATCH':
                if eid not in evs: return await ok({'error': {'message': 'Not Found'}}, 404)
                evs[eid].update(body); evs[eid]['updated'] = self.now(); return await ok(evs[eid])
            if m == 'DELETE':
                evs.pop(eid, None); return await route.fulfill(status=204, headers=self.cors())
        return await ok({'error': {'message': 'unhandled ' + path}}, 404)
    def now(self):
        import datetime
        return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=self.clock_offset)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    clock_offset = 0
    def cors(self): return {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}
    def task_events(self):
        return [e for evs in self.events.values() for e in evs.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoTask')]
