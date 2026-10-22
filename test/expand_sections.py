# Older tests fill fields that now sit in collapsed sections of the dialogs: open every section for them.
# A test that wants the real (collapsed) layout passes new_context(..., compact_ui=True).
try:
    from playwright.async_api import Browser as _B
    if not getattr(_B, '_tempo_patched', False):
        _orig_nc = _B.new_context
        async def _nc(self, *a, compact_ui=False, **kw):
            ctx = await _orig_nc(self, *a, **kw)
            if not compact_ui: await ctx.add_init_script("try { localStorage.setItem('tempo:expandAll', '1'); } catch {}")
            return ctx
        _B.new_context = _nc; _B._tempo_patched = True
except ImportError: pass
