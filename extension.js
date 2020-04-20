// Includes
const St        = imports.gi.St;
const Main      = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Lang      = imports.lang;
const GLib      = imports.gi.GLib;
const Mainloop  = imports.mainloop;
const ByteArray = imports.byteArray;    

// Commands to run
const CMD_VPNSTATUS  = "globalprotect show --status";
const CMD_CONNECT    = "globalprotect connect";
const CMD_DISCONNECT = "globalprotect disconnect";
// Menu display text
const MENU_CONNECT       = "Connect";
const MENU_DISCONNECT    = "Disconnect";
// How many refreshes the state is overridden for
const STATE_OVERRIDE_DURATION=10
// VPN states and associated config
let _states = {
    "GlobalProtect status: Connected": { 
        "panelText":"CONNECTED",// Static panel button text
        "styleClass":"green",   // CSS class for panel button
        "canConnect":false,     // Connect menu item enabled true/false
        "canDisconnect":true,   // Disconnect menu item enabled true/false
        "refreshTimeout":30,    // Seconds to refresh when this is the status
        "clearsOverrideId":1    // Clears a status override with this ID
    },
    "GlobalProtect status: Connecting": { 
        "panelText":"CONNECTING...", // Static panel button text
        "styleClass":"amber",
        "canConnect":false,
        "canDisconnect":true,
        "refreshTimeout":1,
        "overrideId":1               // Allows an override of this state to be cleared by a state with clearsOverrideId of the same ID
    },
    "GlobalProtect status: Disconnected": { 
        "panelText":"UNPROTECTED",
        "styleClass":"red",
        "canConnect":true,
        "canDisconnect":false,
        "refreshTimeout":10,
        "clearsOverrideId":2
    },
    "GlobalProtect status: Disconnecting": { 
        "panelText":"DISCONNECTING...",
        "styleClass":"amber",
        "canConnect":true,
        "canDisconnect":false,
        "refreshTimeout":1,
        "overrideId":2
    },
    "GlobalProtect Status: Reconnecting": { 
        "panelText":"RECONNECTING...",
        "styleClass":"amber",
        "canConnect":false,
        "canDisconnect":true,
        "refreshTimeout":10
    },
    "GlobalProtect Status: Restarting": { 
        "panelText":"RESTARTING...",
        "styleClass":"amber",
        "canConnect":false,
        "canDisconnect":true,
        "refreshTimeout":10
    },
    "ERROR": {
        "panelText":"ERROR",
        "styleClass":"red",
        "canConnect":true,
        "canDisconnect":true,
        "refreshTimeout":5
    }
};

// Extension, panel button, menu items, timeout
let _vpnIndicator, _panelLabel, _statusLabel, _connectMenuItem, _disconnectMenuItem, 
    _connectMenuItemClickId, _disconnectMenuItemClickId, _timeout, _menuItemClickId;

// State persistence
let _stateOverride, _stateOverrideCounter;

const VpnIndicator = new Lang.Class({
    Name: 'VpnIndicator',
    Extends: PanelMenu.Button,

    _init: function () {
        // Init the parent
        this.parent(0.0, "VPN Indicator", false);
    },

    enable: function () {
        // Create the button with label for the panel
        let button = new St.Bin({
            style_class: 'panel-button',
            reactive: true,
            can_focus: true,
            x_fill: true,
            y_fill: false,
            track_hover: true
        });
        _panelLabel = new St.Label();
        button.set_child(_panelLabel);

        // Create the menu items
        _statusLabel = new St.Label({ text: "Checking...", y_expand: true, style_class: "statuslabel" });
        _connectMenuItem = new PopupMenu.PopupMenuItem(MENU_CONNECT);
        _connectMenuItemClickId = _connectMenuItem.connect('activate', Lang.bind(this, this._connect));
        _disconnectMenuItem = new PopupMenu.PopupMenuItem(MENU_DISCONNECT);
        _disconnectMenuItemClickId = _disconnectMenuItem.connect('activate', Lang.bind(this, this._disconnect));
        _updateMenuLabel = new St.Label({ visible: false, style_class: "updatelabel" });

        // Add the menu items to the menu
        this.menu.box.add(_statusLabel);
        this.menu.box.add(_updateMenuLabel);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(_connectMenuItem);
        this.menu.addMenuItem(_disconnectMenuItem);

        // Add the button and a popup menu
        this.actor.add_actor(button);

        this._refresh();
    },

    _refresh: function () {
        // Stop the refreshes
        this._clearTimeout();        

        // Read the VPN status
        let [res, out, err, exit] = GLib.spawn_sync(null, ["/bin/bash", "-c", "/bin/grep gpd /proc/net/route"], null, GLib.SpawnFlags.SEARCH_PATH, null);

        // Determine the correct state from the "Status: xxxx" line
        // TODO: use results from vpn command to give details of error
        let vpnStatus = exit ? _states["GlobalProtect status: Disconnected"] : _states["GlobalProtect status: Connected"];

        // If a state override is active, increment it and override the state if appropriate
        if (_stateOverride) {
            _stateOverrideCounter += 1;

            if (_stateOverrideCounter <= STATE_OVERRIDE_DURATION && vpnStatus.clearsOverrideId != _stateOverride.overrideId) {
                // State override still active
                vpnStatus = _stateOverride;
            } else {
                // State override expired or cleared by current state, remove it
                _stateOverride = undefined;
                _stateOverrideCounter = 0;
            }
        }

        // Update the menu and panel based on the current state
        this._updateMenu(vpnStatus);
        this._updatePanel(vpnStatus);

        // Start the refreshes again
        this._setTimeout(vpnStatus.refreshTimeout);
    },

    _childExited: function (pid, status) {
        // closes the process
        GLib.spawn_close_pid(pid); // check the exit status
    
        if (_stateOverride) {
            // State override cleared
            _stateOverride = undefined;
            _stateOverrideCounter = 0;            
        }
    },
    
    _updateMenu: function (vpnStatus, statusText) {
        // Set the status text on the menu
        _statusLabel.text = vpnStatus.panelText;
        
        // Activate / deactivate menu items
        _connectMenuItem.actor.reactive = vpnStatus.canConnect;
        _disconnectMenuItem.actor.reactive = vpnStatus.canDisconnect;
    },

    _updatePanel: function (vpnStatus) {
        // Update the panel button
        _panelLabel.text = vpnStatus.panelText;
        _panelLabel.style_class = vpnStatus.styleClass;
    },

    _parseCmd: function (cmd) {
        let successP, argv;

        try {
            [successP, argv] = GLib.shell_parse_argv(cmd);
        }
        catch (err) {
            log('ERROR PARSE');
            successP = false;
        }
        if (successP) {
            log('DEBUG: parse: ' + successP + ' argv: ' + argv);
            return [successP, argv];
        } else {
            return [successP, null];
        }
    },

    _spawn: function (cmd, state) {
        let [successP, argv] = this._parseCmd(cmd);
        if (successP) {
            let successS, pid;
            try {
                // Remove proxy from environment
                // Globale Protect use an HTTPS link.
                let envp = GLib.get_environ();
                envp = GLib.environ_unsetenv(envp, "http_proxy");
                envp = GLib.environ_unsetenv(envp, "https_proxy");
                envp = GLib.environ_unsetenv(envp, "all_proxy");
                envp = GLib.environ_unsetenv(envp, "socks_proxy");
                envp = GLib.environ_unsetenv(envp, "ftp_proxy");
                envp = GLib.environ_unsetenv(envp, "HTTP_PROXY");
                envp = GLib.environ_unsetenv(envp, "HTTPS_PROXY");
                envp = GLib.environ_unsetenv(envp, "ALL_PROXY");
                [successS, pid] = GLib.spawn_async(null, argv, envp,
                    GLib.SpawnFlags.SEARCH_PATH |
                    GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);

                // Set an override on the status as the command line status takes a while to catch up
                _stateOverride = state;
                _stateOverrideCounter = 0;

                GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, Lang.bind(this, this._childExited));

                this._refresh();
            }
            catch (err) {
                log('ERROR SPAWN err:' + err.message.toString());
                successS = false;
            }

            if (successS) {
                log('DEBUG: spawn: ' + successS + ' pid: ' + pid);
                return true;
            } else {
                log('spawn ERROR');
                return null;
            }
        }
    },

    _connect: function () {
        // Run the connect command
        this._spawn(CMD_CONNECT, _states["GlobalProtect status: Connecting"]);
    },

    _disconnect: function () {
        // Run the disconnect command
        this._spawn(CMD_DISCONNECT, _states["GlobalProtect status: Disconnecting"]);
    },

    _clearTimeout: function () {
        // Remove the refresh timer if active
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
            this._timeout = undefined;
        }
    },

    _setTimeout: function (timeoutDuration) {
        // Refresh after an interval
        this._timeout = Mainloop.timeout_add_seconds(timeoutDuration, Lang.bind(this, this._refresh));
    },

    disable: function () {

        // Clear timeout and remove menu callback
        this._clearTimeout();

        // Disconnect the menu click handlers
        if (this._connectMenuItemClickId) {
            this._connectMenuItem.disconnect(this._connectMenuItemClickId);
        }
        if (this._disconnectMenuItemClickId) {
            this._disconnectMenuItem.disconnect(this._disconnectMenuItemClickId);
        }
    },

    destroy: function () {
        // Call destroy on the parent
        this.parent();
    }
});


function init() {}

function enable() {
    // Init the indicator
    _vpnIndicator = new VpnIndicator();

    // Add the indicator to the status area of the panel
    if (!_vpnIndicator) _vpnIndicator = new VpnIndicator();
    _vpnIndicator.enable();
    Main.panel.addToStatusArea('vpn-indicator', _vpnIndicator);
}

function disable() {
    // Remove the indicator from the panel
    _vpnIndicator.disable();
    destroy();
}

function destroy () {
    _vpnIndicator.destroy();
    _vpnIndicator = null;
}
