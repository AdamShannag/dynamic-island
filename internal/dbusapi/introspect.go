package dbusapi

import "github.com/godbus/dbus/v5/introspect"

const introXML = `
<node>
  <interface name="` + Iface + `">
    <method name="GetState">
      <arg name="state" type="s" direction="out"/>
    </method>
    <method name="Action">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="Notify">
      <arg name="title" type="s" direction="in"/>
      <arg name="body" type="s" direction="in"/>
      <arg name="icon" type="s" direction="in"/>
      <arg name="accent" type="s" direction="in"/>
      <arg name="timeout_ms" type="i" direction="in"/>
      <arg name="id" type="u" direction="out"/>
    </method>
    <method name="TaskStart">
      <arg name="title" type="s" direction="in"/>
      <arg name="id" type="u" direction="out"/>
    </method>
    <method name="TaskEnd">
      <arg name="id" type="u" direction="in"/>
      <arg name="exit_code" type="i" direction="in"/>
    </method>
    <method name="DockerList">
      <arg name="containers" type="s" direction="out"/>
    </method>
    <method name="DockerLogs">
      <arg name="id" type="s" direction="in"/>
      <arg name="lines" type="i" direction="in"/>
      <arg name="text" type="s" direction="out"/>
    </method>
    <method name="DockerAction">
      <arg name="id" type="s" direction="in"/>
      <arg name="op" type="s" direction="in"/>
    </method>
    <method name="PortsList">
      <arg name="listeners" type="s" direction="out"/>
    </method>
    <method name="PortFree">
      <arg name="port" type="u" direction="in"/>
      <arg name="summary" type="s" direction="out"/>
    </method>
    <method name="SitesList">
      <arg name="sites" type="s" direction="out"/>
    </method>
    <method name="SiteAdd">
      <arg name="url" type="s" direction="in"/>
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="SiteRemove">
      <arg name="id" type="u" direction="in"/>
    </method>
    <method name="ClipboardAdd">
      <arg name="text" type="s" direction="in"/>
    </method>
    <method name="ClipboardList">
      <arg name="items" type="s" direction="out"/>
    </method>
    <method name="ClipboardDelete">
      <arg name="id" type="u" direction="in"/>
    </method>
    <method name="ClipboardPin">
      <arg name="id" type="u" direction="in"/>
      <arg name="pinned" type="b" direction="in"/>
    </method>
    <method name="ClipboardClear"/>
    <method name="AgentEvent">
      <arg name="event" type="s" direction="in"/>
      <arg name="focus" type="ai" direction="in"/>
    </method>
    <method name="AgentStatus">
      <arg name="status" type="s" direction="in"/>
    </method>
    <method name="AgentsList">
      <arg name="sessions" type="s" direction="out"/>
    </method>
    <method name="NotesList">
      <arg name="notes" type="s" direction="out"/>
    </method>
    <method name="NoteCreate">
      <arg name="note" type="s" direction="out"/>
    </method>
    <method name="NoteSave">
      <arg name="id" type="u" direction="in"/>
      <arg name="text" type="s" direction="in"/>
    </method>
    <method name="NotePin">
      <arg name="id" type="u" direction="in"/>
      <arg name="pinned" type="b" direction="in"/>
    </method>
    <method name="NoteDelete">
      <arg name="id" type="u" direction="in"/>
    </method>
    <method name="InboxList">
      <arg name="items" type="s" direction="out"/>
    </method>
    <method name="InboxRemove">
      <arg name="id" type="u" direction="in"/>
    </method>
    <method name="InboxClear"/>
    <method name="QR">
      <arg name="text" type="s" direction="in"/>
      <arg name="png" type="s" direction="out"/>
    </method>
    <method name="PickColor"/>
    <signal name="ColorPicked">
      <arg name="hex" type="s"/>
    </signal>
    <method name="RacePeers">
      <arg name="peers" type="s" direction="out"/>
    </method>
    <method name="RaceState">
      <arg name="state" type="s" direction="out"/>
    </method>
    <method name="RaceCreate"/>
    <method name="RaceInvite">
      <arg name="peer_id" type="s" direction="in"/>
    </method>
    <method name="RaceRespond">
      <arg name="accept" type="b" direction="in"/>
    </method>
    <method name="RaceStart"/>
    <method name="RaceProgress">
      <arg name="typed_chars" type="i" direction="in"/>
    </method>
    <method name="RaceLeave"/>
    <method name="DrawPeers">
      <arg name="peers" type="s" direction="out"/>
    </method>
    <method name="DrawState">
      <arg name="state" type="s" direction="out"/>
    </method>
    <method name="DrawCreate"/>
    <method name="DrawInvite">
      <arg name="peer_id" type="s" direction="in"/>
    </method>
    <method name="DrawRespond">
      <arg name="accept" type="b" direction="in"/>
    </method>
    <method name="DrawStart"/>
    <method name="DrawStroke">
      <arg name="stroke" type="s" direction="in"/>
    </method>
    <method name="DrawGuess">
      <arg name="text" type="s" direction="in"/>
    </method>
    <method name="DrawLeave"/>
    <method name="SetPresenting">
      <arg name="on" type="b" direction="in"/>
    </method>
    <method name="GetSettings">
      <arg name="settings" type="s" direction="out"/>
    </method>
    <method name="SetSettings">
      <arg name="patch" type="s" direction="in"/>
      <arg name="settings" type="s" direction="out"/>
    </method>
    <signal name="SettingsChanged">
      <arg name="settings" type="s"/>
    </signal>
    <method name="SystemStats">
      <arg name="stats" type="s" direction="out"/>
    </method>
    <method name="ActivityList">
      <arg name="items" type="s" direction="out"/>
    </method>
    <method name="Open">
      <arg name="tab" type="s" direction="in"/>
    </method>
    <signal name="OpenDashboard">
      <arg name="tab" type="s"/>
    </signal>
    <signal name="StateChanged">
      <arg name="state" type="s"/>
    </signal>
  </interface>` + introspect.IntrospectDeclarationString + `</node>`
