import Gio from 'gi://Gio';

export const BUS_NAME = 'io.github.AdamShannag.DynamicIsland';
export const OBJECT_PATH = '/io/github/AdamShannag/DynamicIsland';

export const INTERFACE_XML = `
<node>
  <interface name="${BUS_NAME}">
    <method name="GetState"><arg name="state" type="s" direction="out"/></method>
    <method name="Action"><arg name="name" type="s" direction="in"/></method>
    <method name="DockerList"><arg name="containers" type="s" direction="out"/></method>
    <method name="DockerAction">
      <arg name="id" type="s" direction="in"/><arg name="op" type="s" direction="in"/>
    </method>
    <method name="DockerLogs">
      <arg name="id" type="s" direction="in"/><arg name="lines" type="i" direction="in"/>
      <arg name="text" type="s" direction="out"/>
    </method>
    <method name="PortsList"><arg name="listeners" type="s" direction="out"/></method>
    <method name="PortFree">
      <arg name="port" type="u" direction="in"/><arg name="summary" type="s" direction="out"/>
    </method>
    <method name="SitesList"><arg name="sites" type="s" direction="out"/></method>
    <method name="SiteAdd">
      <arg name="url" type="s" direction="in"/><arg name="name" type="s" direction="in"/>
    </method>
    <method name="SiteRemove"><arg name="id" type="u" direction="in"/></method>
    <method name="ClipboardAdd"><arg name="text" type="s" direction="in"/></method>
    <method name="ClipboardList"><arg name="items" type="s" direction="out"/></method>
    <method name="ClipboardDelete"><arg name="id" type="u" direction="in"/></method>
    <method name="ClipboardPin">
      <arg name="id" type="u" direction="in"/><arg name="pinned" type="b" direction="in"/>
    </method>
    <method name="ClipboardClear"/>
    <method name="AgentsList"><arg name="sessions" type="s" direction="out"/></method>
    <method name="ActivityList"><arg name="items" type="s" direction="out"/></method>
    <method name="SystemStats"><arg name="stats" type="s" direction="out"/></method>
    <method name="GetSettings"><arg name="settings" type="s" direction="out"/></method>
    <method name="SetSettings">
      <arg name="patch" type="s" direction="in"/><arg name="settings" type="s" direction="out"/>
    </method>
    <signal name="SettingsChanged"><arg name="settings" type="s"/></signal>
    <method name="NotesList"><arg name="notes" type="s" direction="out"/></method>
    <method name="NoteCreate"><arg name="note" type="s" direction="out"/></method>
    <method name="NoteSave"><arg name="id" type="u" direction="in"/><arg name="text" type="s" direction="in"/></method>
    <method name="NotePin"><arg name="id" type="u" direction="in"/><arg name="pinned" type="b" direction="in"/></method>
    <method name="NoteDelete"><arg name="id" type="u" direction="in"/></method>
    <method name="InboxList"><arg name="items" type="s" direction="out"/></method>
    <method name="InboxRemove"><arg name="id" type="u" direction="in"/></method>
    <method name="InboxClear"/>
    <method name="QR">
      <arg name="text" type="s" direction="in"/><arg name="png" type="s" direction="out"/>
    </method>
    <method name="PickColor"/>
    <method name="SetPresenting"><arg name="on" type="b" direction="in"/></method>
    <signal name="ColorPicked"><arg name="hex" type="s"/></signal>
    <method name="RacePeers"><arg name="peers" type="s" direction="out"/></method>
    <method name="RaceState"><arg name="state" type="s" direction="out"/></method>
    <method name="RaceCreate"/>
    <method name="RaceInvite"><arg name="peer_id" type="s" direction="in"/></method>
    <method name="RaceRespond"><arg name="accept" type="b" direction="in"/></method>
    <method name="RaceStart"/>
    <method name="RaceProgress"><arg name="typed_chars" type="i" direction="in"/></method>
    <method name="RaceLeave"/>
    <signal name="StateChanged"><arg name="state" type="s"/></signal>
    <signal name="OpenDashboard"><arg name="tab" type="s"/></signal>
  </interface>
</node>`;

const IslandProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

export const LOG_PREFIX = 'dynamic-island';

export class DaemonClient {
    constructor({onConnect, onDisconnect, signals}) {
        this._onConnect = onConnect;
        this._onDisconnect = onDisconnect;
        this._signals = signals;
        this._proxy = null;
        this._signalIds = [];
        this._cancellable = null;
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(),
            () => this._disconnect());
    }

    get connected() {
        return !!this._proxy;
    }

    call(method, args = [], cb = null) {
        if (!this._proxy) {
            cb?.(null, new Error('daemon not running'));
            return;
        }
        const fn = this._proxy[`${method}Remote`];
        if (typeof fn !== 'function') {
            console.error(`${LOG_PREFIX}: unknown method ${method}`);
            cb?.(null, new Error(`unknown method ${method}`));
            return;
        }
        fn.call(this._proxy, ...args, (result, err) => {
            if (err)
                console.error(`${LOG_PREFIX}: ${method}: ${err.message}`);
            cb?.(result, err);
        });
    }

    callJson(method, args, cb) {
        this.call(method, args, (res, err) => {
            if (err) {
                cb(null, err);
                return;
            }
            let value;
            try {
                value = JSON.parse(res[0]);
            } catch (e) {
                cb(null, e);
                return;
            }
            cb(value, null);
        });
    }

    destroy() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._disconnect();
    }

    _connect() {
        this._disconnect();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        new IslandProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (cancellable.is_cancelled())
                return;
            if (error) {
                console.error(`${LOG_PREFIX}: proxy: ${error.message}`);
                return;
            }
            this._proxy = proxy;
            this._signalIds = Object.entries(this._signals).map(([name, fn]) =>
                proxy.connectSignal(name, (_p, _sender, args) => fn(...args)));
            this._onConnect(cancellable);
        }, cancellable);
    }

    _disconnect() {
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const id of this._signalIds)
            this._proxy?.disconnectSignal(id);
        this._signalIds = [];
        this._proxy = null;
        this._onDisconnect();
    }
}
