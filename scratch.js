const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const WindowMenu = imports.ui.windowMenu;

const Settings = Extension.imports.settings;
const utils = Extension.imports.utils;
const Easer = Extension.imports.utils.easer;
const Tiling = Extension.imports.tiling;
const TopBar = Extension.imports.topbar;
let float, scratchFrame; // symbols used for expando properties on metawindow

/**
   Tween window to "frame-coordinate" (targetX, targetY).
   The frame is moved once the tween is done.

   The actual window actor (not clone) is tweened to ensure it's on top of the
   other windows/clones (clones if the space animates)
 */
function easeScratch(metaWindow, targetX, targetY, tweenParams = {}) {
    let f = metaWindow.get_frame_rect();
    let b = metaWindow.get_buffer_rect();
    let dx = f.x - b.x;
    let dy = f.y - b.y;

    Easer.addEase(metaWindow.get_compositor_private(), Object.assign(
        {
            time: Settings.prefs.animation_time,
            x: targetX - dx,
            y: targetY - dy,
        },
        tweenParams,
        {
            onComplete (...args) {
                metaWindow.move_frame(true, targetX, targetY);
                tweenParams.onComplete && tweenParams.onComplete.apply(this, args);
            },
        }));
}

function makeScratch(metaWindow) {
    let fromNonScratch = !metaWindow[float];
    let fromTiling = false;
    // Relevant when called while navigating. Use the position the user actually sees.
    let windowPositionSeen;

    if (fromNonScratch) {
        // Figure out some stuff before the window is removed from the tiling
        let space = Tiling.spaces.spaceOfWindow(metaWindow);
        fromTiling = space.indexOf(metaWindow) > -1;
        if (fromTiling) {
            windowPositionSeen = metaWindow.clone
                .get_transformed_position()
                .map(Math.round);
        }
    }

    metaWindow[float] = true;
    metaWindow.make_above();
    metaWindow.stick();  // NB! Removes the window from the tiling (synchronously)

    if (!metaWindow.minimized)
        Tiling.showWindow(metaWindow);

    if (fromTiling) {
        let f = metaWindow.get_frame_rect();
        let targetFrame = null;

        if (metaWindow[scratchFrame]) {
            let sf = metaWindow[scratchFrame];
            if (utils.monitorOfPoint(sf.x, sf.y) === Tiling.focusMonitor()) {
                targetFrame = sf;
            }
        }

        if (!targetFrame) {
            // Default to moving the window slightly down and reducing the height
            let vDisplacement = 30;
            let [x, y] = windowPositionSeen;  // The window could be non-placable so can't use frame

            targetFrame = new Meta.Rectangle({
                x, y: y + vDisplacement,
                width: f.width,
                height: Math.min(f.height - vDisplacement, Math.floor(f.height * 0.9)),
            });
        }

        if (!metaWindow.minimized) {
            metaWindow.move_resize_frame(true, f.x, f.y,
                targetFrame.width, targetFrame.height);
            easeScratch(metaWindow, targetFrame.x, targetFrame.y,
                { onComplete: () => delete metaWindow[scratchFrame] });
        } else {
            // Can't restore the scratch geometry immediately since it distort the minimize animation
            // ASSUMPTION: minimize animation is not disabled and not already done
            let actor = metaWindow.get_compositor_private();
            let signal = actor.connect('effects-completed', () => {
                metaWindow.move_resize_frame(true, targetFrame.x, targetFrame.y,
                    targetFrame.width, targetFrame.height);
                actor.disconnect(signal);
            });
        }
    }

    let monitor = Tiling.focusMonitor();
    if (monitor.clickOverlay)
        monitor.clickOverlay.hide();
}

function unmakeScratch(metaWindow) {
    if (!metaWindow[scratchFrame])
        metaWindow[scratchFrame] = metaWindow.get_frame_rect();
    metaWindow[float] = false;
    metaWindow.unmake_above();
    metaWindow.unstick();
}

function toggle(metaWindow) {
    if (isScratchWindow(metaWindow)) {
        unmakeScratch(metaWindow);
    } else {
        makeScratch(metaWindow);

        if (metaWindow.has_focus) {
            let space = Tiling.spaces.activeSpace;
            space.setSelectionInactive();
        }
    }
}

function isScratchWindow(metaWindow) {
    return metaWindow && metaWindow[float];
}

/** Return scratch windows in MRU order */
function getScratchWindows() {
    return global.display.get_tab_list(Meta.TabList.NORMAL, null)
        .filter(isScratchWindow);
}

function isScratchActive() {
    return getScratchWindows().some(metaWindow => !metaWindow.minimized);
}

function toggleScratch() {
    if (isScratchActive())
        hide();
    else
        show();
}

function toggleScratchWindow() {
    let focus = global.display.focus_window;
    if (isScratchWindow(focus))
        hide();
    else
        show(true);
}

function show(top) {
    let windows = getScratchWindows();
    if (windows.length === 0) {
        return;
    }
    if (top)
        windows = windows.slice(0, 1);

    TopBar.fixTopBar();

    windows.slice().reverse()
        .map(function(meta_window) {
            meta_window.unminimize();
            meta_window.make_above();
            meta_window.get_compositor_private().show();
        });
    windows[0].activate(global.get_current_time());

    let monitor = Tiling.focusMonitor();
    if (monitor.clickOverlay)
        monitor.clickOverlay.hide();
}

function hide() {
    let windows = getScratchWindows();
    windows.map(function(meta_window) {
        meta_window.minimize();
    });
}

function animateWindows() {
    let ws = getScratchWindows().filter(w => !w.minimized);
    ws = global.display.sort_windows_by_stacking(ws);
    for (let w of ws) {
        let parent = w.clone.get_parent();
        parent && parent.remove_child(w.clone);
        Main.uiGroup.insert_child_below(w.clone, Main.layoutManager.panelBox);
        let f = w.get_frame_rect();
        w.clone.set_position(f.x, f.y);
        Tiling.animateWindow(w);
    }
}

function showWindows() {
    let ws = getScratchWindows().filter(w => !w.minimized);
    ws.forEach(Tiling.showWindow);
}

let originalBuildMenu;
function enable() {
    originalBuildMenu = WindowMenu.WindowMenu.prototype._buildMenu;
    float = Symbol();
    scratchFrame = Symbol();
    WindowMenu.WindowMenu.prototype._buildMenu =
        function (window) {
            let item;
            item = this.addAction(_('Scratch'), () => {
                toggle(window);
            });
            if (isScratchWindow(window))
                item.setOrnament(PopupMenu.Ornament.CHECK);

            originalBuildMenu.call(this, window);
        };
}

function disable() {
    WindowMenu.WindowMenu.prototype._buildMenu = originalBuildMenu;
    originalBuildMenu = null;
    float = null;
    scratchFrame = null;
}
