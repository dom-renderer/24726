/* ============================================================================
   Automation Canvas Editor — JavaScript Engine
   ----------------------------------------------------------------------------
   A world-class node-based automation builder, forked from the n8n Workflow
   editor visual chrome. Reuses the exact same `n8n-*` CSS design system so it
   looks identical, but operates on an automation graph (nodes + edges) instead
   of workflow sections/steps.

   Public API:
       window.AutomationEditor
       new AutomationEditor(container, data)

   Domain model
       node  = { id, type, subtype, name, config, x, y }
       edge  = { id, source, target, branchKey }

   type   ∈ trigger | condition | action | flow
   ============================================================================ */

(function () {
    'use strict';

    // ─── Type accent colors (spec) ───────────────────────────────────────
    const TYPE_COLORS = {
        trigger:   '#0f766e',
        condition: '#7c3aed',
        action:    '#b45309',
        flow:      '#334155'
    };

    const TYPE_LABELS = {
        trigger:   'Trigger',
        condition: 'Condition',
        action:    'Action',
        flow:      'Flow'
    };

    // ─── Node Catalog ────────────────────────────────────────────────────
    //  Every draggable/addable node type lives here. Grouped into drawer
    //  categories. `icon` uses Bootstrap Icons class names.
    const CATALOG = {
        // ── Triggers ──
        schedule:              { type: 'trigger',   label: 'Schedule',            icon: 'bi-clock-history',      desc: 'Run on a recurring time schedule' },
        webhook:               { type: 'trigger',   label: 'Webhook',             icon: 'bi-link-45deg',         desc: 'Trigger from an incoming HTTP call' },
        record:                { type: 'trigger',   label: 'Record event',        icon: 'bi-collection',         desc: 'When a location, ticket, checklist, asset, or other record changes' },
        manual:                { type: 'trigger',   label: 'Manual',              icon: 'bi-hand-index-thumb',   desc: 'Start the automation on demand' },
        // Legacy subtypes (still render if already on a canvas)
        'checklist.submitted': { type: 'trigger',   label: 'Checklist Submitted', icon: 'bi-clipboard-check',    desc: 'When a checklist gets submitted' },
        ticket:                { type: 'trigger',   label: 'Ticket',              icon: 'bi-ticket-detailed',    desc: 'When a ticket is created, updated, or closed' },
        asset:                 { type: 'trigger',   label: 'Asset',               icon: 'bi-box-seam',           desc: 'When an asset is created or specific fields change' },
        location:              { type: 'trigger',   label: 'Location',            icon: 'bi-geo-alt',            desc: 'When a location is created or specific fields change' },
        'ticket.created':      { type: 'trigger',   label: 'Ticket Created',      icon: 'bi-ticket',             desc: 'When a new ticket is created' },
        'ticket.updated':      { type: 'trigger',   label: 'Ticket Updated',      icon: 'bi-arrow-repeat',       desc: 'When a ticket is updated' },
        'ticket.closed':       { type: 'trigger',   label: 'Ticket Closed',       icon: 'bi-ticket-detailed',    desc: 'When a ticket is closed' },
        'asset.changed':       { type: 'trigger',   label: 'Asset Changed',       icon: 'bi-box-seam',           desc: 'When an asset is created or updated' },
        'location.changed':    { type: 'trigger',   label: 'Location Changed',    icon: 'bi-geo-alt',            desc: 'When a location is created or updated' },

        // ── Conditions ──
        if_else:               { type: 'condition', label: 'If / Else',           icon: 'bi-diagram-2',          desc: 'Branch based on conditions' },

        // ── Actions ──
        assign_checklist:      { type: 'action',    label: 'Assign Checklist',    icon: 'bi-clipboard-plus',     desc: 'Assign a checklist to people' },
        notify:                { type: 'action',    label: 'Notify',              icon: 'bi-bell',               desc: 'Send an email / push notification' },
        create_ticket:         { type: 'action',    label: 'Create Ticket',       icon: 'bi-ticket-perforated',  desc: 'Open a new support ticket' },
        http_request:          { type: 'action',    label: 'HTTP Request',        icon: 'bi-cloud-arrow-up',     desc: 'Call an external API endpoint' },

        // ── Flow ──
        wait:                  { type: 'flow',      label: 'Wait',                icon: 'bi-hourglass-split',    desc: 'Pause for a fixed duration' },
        wait_until:            { type: 'flow',      label: 'Wait Until',          icon: 'bi-hourglass',          desc: 'Wait for an event or timeout' },
        for_each:              { type: 'flow',      label: 'For Each',            icon: 'bi-collection',         desc: 'Loop over a collection' },
        parallel:              { type: 'flow',      label: 'Parallel',            icon: 'bi-signpost-split',     desc: 'Run branches simultaneously' },
        merge:                 { type: 'flow',      label: 'Merge',               icon: 'bi-signpost-2',         desc: 'Join branches back together' },
        approval:              { type: 'flow',      label: 'Approval',            icon: 'bi-person-check',       desc: 'Require a human approval' },
        dedupe:                { type: 'flow',      label: 'Dedupe',              icon: 'bi-funnel',             desc: 'Skip duplicate executions' },
        end:                   { type: 'flow',      label: 'End',                 icon: 'bi-stop-circle',        desc: 'Terminate this branch' }
    };

    const CATEGORIES = [
        { key: 'trigger',   title: 'Triggers',   subtypes: ['schedule', 'webhook', 'record', 'manual'] },
        { key: 'condition', title: 'Conditions', subtypes: ['if_else'] },
        { key: 'action',    title: 'Actions',    subtypes: ['assign_checklist', 'notify', 'create_ticket', 'http_request'] },
        { key: 'flow',      title: 'Flow',       subtypes: ['wait', 'wait_until', 'for_each', 'parallel', 'merge', 'approval', 'dedupe', 'end'] }
    ];

    const RECORD_SOURCES = [
        { value: 'location', label: 'Location' },
        { value: 'ticket', label: 'Ticket' },
        { value: 'document', label: 'Document' },
        { value: 'checklist', label: 'Checklist' },
        { value: 'asset', label: 'Asset' },
        { value: 'user', label: 'User' },
        { value: 'role', label: 'Role' },
        { value: 'task', label: 'Task' },
        { value: 'zone', label: 'Zone' }
    ];

    // ─── Branch / output-port definitions per subtype ────────────────────
    function outPortsFor(subtype) {
        switch (subtype) {
            case 'if_else':      return [{ key: 'true', label: 'Yes' }, { key: 'false', label: 'No' }];
            case 'wait_until':   return [{ key: null, label: 'Done' }, { key: 'timeout', label: 'Timeout' }];
            case 'for_each':     return [{ key: 'loop', label: 'Each' }, { key: null, label: 'After' }];
            case 'approval':     return [{ key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }];
            case 'http_request': return [{ key: 'success', label: 'Success' }, { key: 'failure', label: 'Failure' }];
            case 'parallel':     return [{ key: 'b1', label: 'Branch 1' }, { key: 'b2', label: 'Branch 2' }, { key: 'after', label: 'After' }];
            case 'dedupe':       return [{ key: 'continue', label: 'Continue' }, { key: 'duplicate', label: 'Duplicate' }];
            case 'end':          return [];
            default:             return [{ key: null, label: '' }];
        }
    }

    const DEDUPE_TOKENS = [
        { token: '{{checklist_id}}', label: 'Checklist' },
        { token: '{{user_id}}', label: 'User' },
        { token: '{{store_id}}', label: 'Store / Asset' },
        { token: '{{ticket_id}}', label: 'Ticket' },
        { token: '{{date}}', label: 'Date' },
        { token: '{{automation_id}}', label: 'Automation' }
    ];

    const EVENT_OPTIONS = [
        { value: 'checklist.submitted', label: 'Checklist submitted' },
        { value: 'ticket.created', label: 'Ticket created' },
        { value: 'ticket.updated', label: 'Ticket updated' },
        { value: 'ticket.closed', label: 'Ticket closed' },
        { value: 'asset.changed', label: 'Asset changed' },
        { value: 'location.changed', label: 'Location changed' }
    ];

    const TICKET_EVENT_OPTIONS = [
        { value: 'created', label: 'Created' },
        { value: 'updated', label: 'Updated' },
        { value: 'closed', label: 'Closed' }
    ];

    const ENTITY_ACTION_OPTIONS = [
        { value: 'created', label: 'Created' },
        { value: 'updated', label: 'Updated' }
    ];

    const LOCATION_CHANGE_FIELDS = [
        { value: 'open_time', label: 'Opening time' },
        { value: 'close_time', label: 'Closing time' },
        { value: 'ops_start_time', label: 'Ops start time' },
        { value: 'ops_end_time', label: 'Ops end time' },
        { value: 'name', label: 'Name' },
        { value: 'address1', label: 'Address' },
        { value: 'status', label: 'Status' },
        { value: 'mobile', label: 'Mobile' },
        { value: 'email', label: 'Email' },
        { value: 'zone_id', label: 'Zone' },
        { value: 'region_id', label: 'Region' },
        { value: 'operational_node_id', label: 'Operational node' },
        { value: 'latitude', label: 'Latitude' },
        { value: 'longitude', label: 'Longitude' }
    ];

    const ASSET_CHANGE_FIELDS = [
        { value: 'name', label: 'Name' },
        { value: 'code', label: 'Code' },
        { value: 'ucode', label: 'U-code' },
        { value: 'asset_status_id', label: 'Asset status' },
        { value: 'asset_type_id', label: 'Asset type' },
        { value: 'location', label: 'Parent location' },
        { value: 'status', label: 'Status' },
        { value: 'warranty', label: 'Warranty' },
        { value: 'purchase_cost', label: 'Purchase cost' },
        { value: 'notes', label: 'Notes' }
    ];

    // Value widgets for known condition fields (valueType drives the UI).
    const CONDITION_VALUE_TYPES = {
        ticket_priority: [
            { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }
        ],
        ticket_status: [
            { value: 'pending', label: 'Pending' }, { value: 'accepted', label: 'Accepted' },
            { value: 'in_progress', label: 'In progress' }, { value: 'closed', label: 'Closed' }
        ],
        trigger_type: [
            { value: 'schedule', label: 'Schedule' },
            { value: 'webhook', label: 'Webhook' },
            { value: 'manual', label: 'Manual' },
            { value: 'checklist.submitted', label: 'Checklist submitted' },
            { value: 'ticket', label: 'Ticket' },
            { value: 'ticket.created', label: 'Ticket created' },
            { value: 'ticket.updated', label: 'Ticket updated' },
            { value: 'ticket.closed', label: 'Ticket closed' },
            { value: 'asset', label: 'Asset' },
            { value: 'asset.changed', label: 'Asset changed' },
            { value: 'location', label: 'Location' },
            { value: 'location.changed', label: 'Location changed' }
        ],
        bool: [
            { value: 'true', label: 'Yes / true' },
            { value: 'false', label: 'No / false' }
        ],
        count: [
            { value: '0', label: '0' }, { value: '1', label: '1' }, { value: '2', label: '2' },
            { value: '3', label: '3' }, { value: '5', label: '5' }, { value: '10', label: '10' }
        ],
        change_action: [
            { value: 'created', label: 'Created' },
            { value: 'updated', label: 'Updated' }
        ],
        task_status: [
            { value: '0', label: 'Pending' },
            { value: '1', label: 'In progress' },
            { value: '2', label: 'Done' }
        ],
        http_status: [
            { value: '200', label: '200 OK' }, { value: '201', label: '201 Created' },
            { value: '204', label: '204 No content' }, { value: '400', label: '400 Bad request' },
            { value: '401', label: '401 Unauthorized' }, { value: '403', label: '403 Forbidden' },
            { value: '404', label: '404 Not found' }, { value: '422', label: '422 Validation' },
            { value: '500', label: '500 Server error' }
        ],
        percent: [
            { value: '50', label: '50%' }, { value: '60', label: '60%' }, { value: '70', label: '70%' },
            { value: '80', label: '80%' }, { value: '90', label: '90%' }, { value: '100', label: '100%' }
        ]
    };

    const CUSTOM_VALUE = '__custom__';
    const PICK_VALUE = '__pick__';

    // Fields available from each trigger subtype (paths under run context).
    const TRIGGER_FIELD_MAP = {
        'checklist.submitted': [
            { path: 'trigger.checklist_id', label: 'Checklist', valueType: 'checklist' },
            { path: 'trigger.user_id', label: 'Submitted by (user)', valueType: 'user' },
            { path: 'trigger.store_id', label: 'Store / asset', valueType: 'asset' },
            { path: 'trigger.task_id', label: 'Task ID', valueType: 'text' },
            { path: 'trigger.status', label: 'Task status', valueType: 'task_status' },
            { path: 'trigger.percentage', label: 'Task score %', valueType: 'percent' }
        ],
        ticket: [
            { path: 'trigger.action', label: 'Ticket event (created/updated/closed)', valueType: 'text' },
            { path: 'trigger.ticket_id', label: 'Ticket ID', valueType: 'text' },
            { path: 'trigger.ticket_number', label: 'Ticket number', valueType: 'text' },
            { path: 'trigger.priority', label: 'Priority', valueType: 'ticket_priority' },
            { path: 'trigger.status', label: 'Status', valueType: 'ticket_status' },
            { path: 'trigger.store_id', label: 'Store / asset', valueType: 'asset' },
            { path: 'trigger.department_id', label: 'Department ID', valueType: 'text' },
            { path: 'trigger.particular_id', label: 'Particular ID', valueType: 'text' },
            { path: 'trigger.issue_id', label: 'Issue ID', valueType: 'text' }
        ],
        'ticket.created': [
            { path: 'trigger.ticket_id', label: 'Ticket ID', valueType: 'text' },
            { path: 'trigger.ticket_number', label: 'Ticket number', valueType: 'text' },
            { path: 'trigger.priority', label: 'Priority', valueType: 'ticket_priority' },
            { path: 'trigger.status', label: 'Status', valueType: 'ticket_status' },
            { path: 'trigger.store_id', label: 'Store / asset', valueType: 'asset' },
            { path: 'trigger.department_id', label: 'Department ID', valueType: 'text' },
            { path: 'trigger.particular_id', label: 'Particular ID', valueType: 'text' },
            { path: 'trigger.issue_id', label: 'Issue ID', valueType: 'text' }
        ],
        'ticket.updated': [
            { path: 'trigger.ticket_id', label: 'Ticket ID', valueType: 'text' },
            { path: 'trigger.ticket_number', label: 'Ticket number', valueType: 'text' },
            { path: 'trigger.priority', label: 'Priority', valueType: 'ticket_priority' },
            { path: 'trigger.status', label: 'Status', valueType: 'ticket_status' },
            { path: 'trigger.store_id', label: 'Store / asset', valueType: 'asset' },
            { path: 'trigger.department_id', label: 'Department ID', valueType: 'text' },
            { path: 'trigger.particular_id', label: 'Particular ID', valueType: 'text' },
            { path: 'trigger.issue_id', label: 'Issue ID', valueType: 'text' }
        ],
        'ticket.closed': [
            { path: 'trigger.ticket_id', label: 'Ticket ID', valueType: 'text' },
            { path: 'trigger.ticket_number', label: 'Ticket number', valueType: 'text' },
            { path: 'trigger.priority', label: 'Priority', valueType: 'ticket_priority' },
            { path: 'trigger.status', label: 'Status', valueType: 'ticket_status' },
            { path: 'trigger.store_id', label: 'Store / asset', valueType: 'asset' },
            { path: 'trigger.department_id', label: 'Department ID', valueType: 'text' },
            { path: 'trigger.particular_id', label: 'Particular ID', valueType: 'text' },
            { path: 'trigger.issue_id', label: 'Issue ID', valueType: 'text' }
        ],
        asset: [
            { path: 'trigger.action', label: 'Change type (created/updated)', valueType: 'change_action' },
            { path: 'trigger.asset_id', label: 'Asset', valueType: 'asset' },
            { path: 'trigger.store_id', label: 'Store / asset ID', valueType: 'asset' },
            { path: 'trigger.name', label: 'Asset name', valueType: 'text' },
            { path: 'trigger.code', label: 'Asset code', valueType: 'text' },
            { path: 'trigger.ucode', label: 'Asset U-code', valueType: 'text' }
        ],
        'asset.changed': [
            { path: 'trigger.asset_id', label: 'Asset', valueType: 'asset' },
            { path: 'trigger.store_id', label: 'Store / asset ID', valueType: 'asset' },
            { path: 'trigger.name', label: 'Asset name', valueType: 'text' },
            { path: 'trigger.code', label: 'Asset code', valueType: 'text' },
            { path: 'trigger.ucode', label: 'Asset U-code', valueType: 'text' },
            { path: 'trigger.action', label: 'Change type (created/updated)', valueType: 'change_action' }
        ],
        location: [
            { path: 'trigger.action', label: 'Change type (created/updated)', valueType: 'change_action' },
            { path: 'trigger.location_id', label: 'Location', valueType: 'store' },
            { path: 'trigger.store_id', label: 'Location ID', valueType: 'store' },
            { path: 'trigger.name', label: 'Location name', valueType: 'text' },
            { path: 'trigger.code', label: 'Location code', valueType: 'text' },
            { path: 'trigger.open_time', label: 'Opening time', valueType: 'text' },
            { path: 'trigger.close_time', label: 'Closing time', valueType: 'text' }
        ],
        'location.changed': [
            { path: 'trigger.location_id', label: 'Location', valueType: 'store' },
            { path: 'trigger.store_id', label: 'Location ID', valueType: 'store' },
            { path: 'trigger.name', label: 'Location name', valueType: 'text' },
            { path: 'trigger.code', label: 'Location code', valueType: 'text' },
            { path: 'trigger.action', label: 'Change type (created/updated)', valueType: 'change_action' },
            { path: 'trigger.open_time', label: 'Opening time', valueType: 'text' },
            { path: 'trigger.close_time', label: 'Closing time', valueType: 'text' }
        ],
        webhook: [
            { path: 'trigger_type', label: 'Trigger type', valueType: 'trigger_type' }
        ],
        schedule: [
            { path: 'trigger_type', label: 'Trigger type', valueType: 'trigger_type' }
        ],
        manual: [
            { path: 'trigger_type', label: 'Trigger type', valueType: 'trigger_type' }
        ],
        checklist: [
            { path: 'trigger.action', label: 'Action (created/updated)', valueType: 'change_action' },
            { path: 'trigger.checklist_id', label: 'Checklist', valueType: 'checklist' },
            { path: 'trigger.name', label: 'Checklist name', valueType: 'text' }
        ],
        task: [
            { path: 'trigger.action', label: 'Action (updated / in progress / submitted)', valueType: 'text' },
            { path: 'trigger.task_id', label: 'Task', valueType: 'task' },
            { path: 'trigger.checklist_id', label: 'Checklist', valueType: 'checklist' },
            { path: 'trigger.status', label: 'Task status', valueType: 'task_status' },
            { path: 'trigger.percentage', label: 'Task score %', valueType: 'percent' },
            { path: 'trigger.user_id', label: 'Assignee / user', valueType: 'user' },
            { path: 'trigger.store_id', label: 'Store / asset', valueType: 'asset' }
        ],
        document: [
            { path: 'trigger.action', label: 'Action (created/updated)', valueType: 'change_action' },
            { path: 'trigger.document_id', label: 'Document ID', valueType: 'text' },
            { path: 'trigger.name', label: 'Document name', valueType: 'text' }
        ],
        user: [
            { path: 'trigger.action', label: 'Action (created/updated)', valueType: 'change_action' },
            { path: 'trigger.user_id', label: 'User', valueType: 'user' },
            { path: 'trigger.name', label: 'User name', valueType: 'text' }
        ],
        role: [
            { path: 'trigger.action', label: 'Action (created/updated)', valueType: 'change_action' },
            { path: 'trigger.role_id', label: 'Role ID', valueType: 'text' },
            { path: 'trigger.name', label: 'Role name', valueType: 'text' }
        ],
        zone: [
            { path: 'trigger.action', label: 'Action (created/updated)', valueType: 'change_action' },
            { path: 'trigger.zone_id', label: 'Zone ID', valueType: 'text' },
            { path: 'trigger.name', label: 'Zone name', valueType: 'text' }
        ]
    };

    // Live DB lookups: pick a table, then a column (whitelisted).
    const LOOKUP_FIELD_PATH = 'lookup.table_column';
    const LOOKUP_TABLES = [
        {
            value: 'checklist_tasks',
            label: 'Checklist tasks',
            columns: [
                { value: 'percentage', label: 'Score %', valueType: 'percent' },
                { value: 'status', label: 'Status', valueType: 'task_status' },
                { value: 'id', label: 'Task ID', valueType: 'text' }
            ],
            filters: [
                { key: 'checklist_id', label: 'Checklist', valueType: 'checklist' }
            ]
        },
        {
            value: 'new_tickets',
            label: 'Tickets',
            columns: [
                { value: 'priority', label: 'Priority', valueType: 'ticket_priority' },
                { value: 'status', label: 'Status', valueType: 'ticket_status' },
                { value: 'department_id', label: 'Department ID', valueType: 'text' },
                { value: 'particular_id', label: 'Particular ID', valueType: 'text' },
                { value: 'issue_id', label: 'Issue ID', valueType: 'text' },
                { value: 'store_id', label: 'Store / asset ID', valueType: 'text' },
                { value: 'ticket_number', label: 'Ticket number', valueType: 'text' }
            ],
            filters: []
        },
        {
            value: 'dynamic_forms',
            label: 'Checklists',
            columns: [
                { value: 'name', label: 'Name', valueType: 'text' },
                { value: 'status', label: 'Status', valueType: 'text' },
                { value: 'id', label: 'Checklist ID', valueType: 'text' }
            ],
            filters: [
                { key: 'id', label: 'Checklist', valueType: 'checklist' }
            ]
        },
        {
            value: 'users',
            label: 'Users',
            columns: [
                { value: 'name', label: 'First name', valueType: 'text' },
                { value: 'last_name', label: 'Last name', valueType: 'text' },
                { value: 'email', label: 'Email', valueType: 'text' },
                { value: 'employee_id', label: 'Employee ID', valueType: 'text' },
                { value: 'status', label: 'Status', valueType: 'text' },
                { value: 'id', label: 'User ID', valueType: 'text' }
            ],
            filters: [
                { key: 'ids', label: 'Users', valueType: 'user', multiple: true }
            ]
        },
        {
            value: 'stores',
            label: 'Locations / assets',
            columns: [
                { value: 'name', label: 'Name', valueType: 'text' },
                { value: 'code', label: 'Code', valueType: 'text' },
                { value: 'ucode', label: 'U-code', valueType: 'text' },
                { value: 'open_time', label: 'Opening time', valueType: 'text' },
                { value: 'close_time', label: 'Closing time', valueType: 'text' },
                { value: 'id', label: 'ID', valueType: 'text' }
            ],
            filters: [
                { key: 'ids', label: 'Locations / assets', valueType: 'asset', multiple: true }
            ]
        }
    ];

    const LOOKUP_CONDITION_FIELDS = [
        {
            path: LOOKUP_FIELD_PATH,
            label: 'Table / column lookup',
            valueType: 'table_lookup',
            help: 'Pick a table, then a column, then compare its value.'
        }
    ];

    const NODE_OUTPUT_FIELDS = {
        assign_checklist: [
            { suffix: 'assigned_user_ids', label: 'Assigned user', valueType: 'user' },
            { suffix: 'assigned_task_ids', label: 'Assigned task', valueType: 'task' },
            { suffix: 'scheduling_id', label: 'Checklist schedule', valueType: 'scheduling' }
        ],
        notify: [
            { suffix: 'recipient_count', label: 'Recipient count', valueType: 'count' },
            { suffix: 'emailed', label: 'Emails sent', valueType: 'count' },
            { suffix: 'pushed', label: 'Push sent', valueType: 'count' }
        ],
        create_ticket: [
            { suffix: 'ticket_id', label: 'Created ticket ID', valueType: 'text' }
        ],
        http_request: [
            { suffix: 'ok', label: 'Request succeeded', valueType: 'bool' },
            { suffix: 'status', label: 'HTTP status code', valueType: 'http_status' }
        ],
        approval: [
            { suffix: 'approval_id', label: 'Approval ID', valueType: 'text' }
        ],
        if_else: [
            { suffix: 'result', label: 'Condition result (true/false)', valueType: 'bool' }
        ]
    };

    const humanLabel = (subtype) => (CATALOG[subtype] ? CATALOG[subtype].label : subtype);

    // ─── AutomationEditor Class ──────────────────────────────────────────
    window.AutomationEditor = class AutomationEditor {
        constructor(container, data) {
            this.container = typeof container === 'string' ? document.querySelector(container) : container;
            this.data = data || {};

            // Graph state
            this.nodes = [];
            this.edges = [];
            this.selectedNodes = [];
            this.selectedEdge = null;

            // Option lists (may be augmented via ajax)
            this.roles = (this.data.roles || []).map(r => ({ value: r.id, label: r.name }));
            this.checklists = (this.data.checklists || []).map(c => ({ value: c.id, label: c.name }));
            this.users = (this.data.users || []).map(u => ({ value: u.id, label: (u.name || '') + (u.last_name ? ' ' + u.last_name : '') }));
            this.assets = (this.data.assets || []).map(a => ({ value: a.id, label: a.name || a.text || ('#' + a.id) }));
            this.notifications = (this.data.notifications || []).map(n => ({ value: n.id, label: n.name || n.title, type: n.type }));
            this.timezones = (this.data.timezones && this.data.timezones.length)
                ? this.data.timezones.map(t => (typeof t === 'string' ? { value: t, label: t } : { value: t.value || t.id, label: t.label || t.name }))
                : [{ value: 'UTC', label: 'UTC' }];

            // Canvas state
            this.zoom = 1;
            this.panX = 0;
            this.panY = 0;
            this.isPanning = false;
            this.panStart = { x: 0, y: 0 };
            this.isDragging = false;
            this.dragNode = null;
            this.dragOffset = { x: 0, y: 0 };

            // Connection creation
            this.isConnecting = false;
            this.connectFrom = null;
            this.connectBranch = null;
            this.tempLine = null;

            // UI state
            this.minimapVisible = false;
            this.drawerOpen = false;
            this.configOpen = false;
            this.configNode = null;
            this.nodeDidDrag = false;

            // Meta
            this.name = this.data.name || 'Untitled Automation';
            this.description = this.data.description || '';
            this.status = this.data.status || 'draft';

            this._init();
        }

        _init() {
            this._parseData();
            this._buildLayout();
            this._bindEvents();
            if (!this._hasPositions()) this._autoLayout();
            this._renderNodes();
            this._renderConnections();
            this._bindNodeEvents();
            this._updateStatusUI();
            this._updateMinimap();
            this._fitToView();
            this._loadRemote();
        }

        _parseData() {
            const graph = this.data.graph || {};
            (graph.nodes || []).forEach(n => {
                this.nodes.push({
                    id: n.id || n.key || this._uid('n'),
                    type: n.type || (CATALOG[n.subtype] ? CATALOG[n.subtype].type : 'action'),
                    subtype: n.subtype,
                    name: n.name || humanLabel(n.subtype),
                    config: n.config ? JSON.parse(JSON.stringify(n.config)) : {},
                    subtitle: n.subtitle || null,
                    theme: n.theme || null,
                    dashed: n.dashed || false,
                    x: typeof n.x === 'number' ? n.x : (n.position && typeof n.position.x === 'number' ? n.position.x : 0),
                    y: typeof n.y === 'number' ? n.y : (n.position && typeof n.position.y === 'number' ? n.position.y : 0),
                    w: 220, h: 75
                });
            });
            (graph.edges || []).forEach(e => {
                this.edges.push({
                    id: e.id || e.key || this._uid('e'),
                    source: e.source,
                    target: e.target,
                    dashed: e.dashed || false,
                    branchKey: (e.branchKey !== undefined ? e.branchKey : (e.branch !== undefined ? e.branch : null))
                });
            });

            if (this.nodes.length <= 1) {
                this._loadSamplePipelineGraph();
            }

            this.nodes.forEach(n => { n.h = this._nodeHeight(n); });
        }

        _loadSamplePipelineGraph() {
            this.nodes = [
                { id: 'n_1', type: 'trigger', subtype: 'schedule', name: 'Schedule Trigger', subtitle: 'Every day at 08:00 AM', x: 350, y: 20, w: 230, h: 65, config: {} },
                { id: 'n_2', type: 'flow', subtype: 'parallel', name: 'For Each Asset', subtitle: 'Asset Type: Vehicle\nLocation: All', x: 350, y: 135, w: 230, h: 70, config: {} },
                { id: 'n_3', type: 'action', subtype: 'assign_checklist', name: 'Assign Checklist', subtitle: 'Checklist: Daily Vehicle Inspection\nAssign to: Asset Owner', x: 350, y: 250, w: 230, h: 75, config: {} },
                { id: 'n_4', type: 'condition', subtype: 'if_else', name: 'Checklist Submitted?', subtitle: 'Wait up to 4 hours', theme: 'yellow', x: 350, y: 370, w: 230, h: 75, config: {} },
                { id: 'n_5', type: 'action', subtype: 'notify', name: 'Reminder', subtitle: 'Send reminder to user\nEvery 30 minutes', x: 130, y: 490, w: 210, h: 75, config: {} },
                { id: 'n_6', type: 'condition', subtype: 'if_else', name: 'Submitted after 4 hours?', subtitle: '', theme: 'red', x: 130, y: 620, w: 210, h: 75, config: {} },
                { id: 'n_7', type: 'action', subtype: 'notify', name: 'Escalate', subtitle: 'Notify Supervisor\nand Asset Owner', x: -20, y: 750, w: 190, h: 75, config: {} },
                { id: 'n_8', type: 'action', subtype: 'create_ticket', name: 'Create Ticket', subtitle: 'Type: Missed Inspection\nPriority: High', x: 220, y: 750, w: 210, h: 75, config: {} },
                { id: 'n_9', type: 'condition', subtype: 'wait_until', name: 'Inspection Score ≥ 80?', subtitle: '', theme: 'blue', x: 600, y: 490, w: 230, h: 75, config: {} },
                { id: 'n_10', type: 'action', subtype: 'asset', name: 'Update Asset Status', subtitle: 'Status: Inspection Passed\nNext Inspection in 24 hrs', x: 810, y: 580, w: 220, h: 75, config: {} },
                { id: 'n_11', type: 'action', subtype: 'notify', name: 'Complete Workflow', subtitle: 'Mark as completed\nSend success notification', x: 810, y: 710, w: 220, h: 75, config: {} },
                { id: 'n_12', type: 'action', subtype: 'create_ticket', name: 'Create Ticket', subtitle: 'Type: Inspection Failed\nPriority: High', x: 540, y: 620, w: 210, h: 75, config: {} },
                { id: 'n_13', type: 'action', subtype: 'notify', name: 'Notify Users', subtitle: 'Notify Maintenance Team\nand Supervisor', x: 540, y: 735, w: 210, h: 75, config: {} },
                { id: 'n_14', type: 'flow', subtype: 'wait', name: 'Wait', subtitle: 'Until ticket is resolved\nCheck every 2 hours', x: 540, y: 850, w: 210, h: 75, config: {} }
            ];

            this.edges = [
                { id: 'e_1', source: 'n_1', target: 'n_2', branchKey: null },
                { id: 'e_2', source: 'n_2', target: 'n_3', branchKey: null },
                { id: 'e_3', source: 'n_3', target: 'n_4', branchKey: null },
                { id: 'e_4', source: 'n_4', target: 'n_5', branchKey: 'false' },
                { id: 'e_5', source: 'n_4', target: 'n_9', branchKey: 'true' },
                { id: 'e_6', source: 'n_5', target: 'n_6', branchKey: null },
                { id: 'e_7', source: 'n_6', target: 'n_7', branchKey: 'false' },
                { id: 'e_8', source: 'n_6', target: 'n_8', branchKey: 'true' },
                { id: 'e_9', source: 'n_9', target: 'n_10', branchKey: 'true' },
                { id: 'e_10', source: 'n_9', target: 'n_12', branchKey: 'false' },
                { id: 'e_11', source: 'n_10', target: 'n_11', branchKey: null },
                { id: 'e_12', source: 'n_12', target: 'n_13', branchKey: null },
                { id: 'e_13', source: 'n_13', target: 'n_14', branchKey: null },
                { id: 'e_14', source: 'n_14', target: 'n_11', branchKey: null, dashed: true },
                { id: 'e_15', source: 'n_8', target: 'n_14', branchKey: null, dashed: true }
            ];
        }

        _hasPositions() {
            return this.nodes.some(n => n.x !== 0 || n.y !== 0);
        }

        _uid(prefix) {
            return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
        }

        _esc(str) {
            const div = document.createElement('div');
            div.textContent = str == null ? '' : str;
            return div.innerHTML;
        }

        _getNodeById(id) {
            const s = String(id);
            return this.nodes.find(n => String(n.id) === s);
        }

        _nodeHeight(node) {
            const ports = outPortsFor(node.subtype);
            if (ports.length <= 1) return 75;
            return Math.max(75, 24 + ports.length * 26);
        }

        _hasInput(node) {
            return node.type !== 'trigger';
        }

        // ─── Remote option loading (ajax) ────────────────────────────────
        _csrfHeaders() {
            return {
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json',
                'X-CSRF-TOKEN': this.data.csrfToken || ''
            };
        }

        _normSelect2Items(raw) {
            let arr = raw;
            if (raw && !Array.isArray(raw)) arr = raw.data || raw.results || raw.items || [];
            if (!Array.isArray(arr)) return [];
            return arr.map(o => ({
                value: o.id != null ? o.id : (o.value != null ? o.value : o),
                label: o.text || o.name
                    ? (o.text || (o.name + (o.last_name ? ' ' + o.last_name : '')))
                    : (o.label || o.title || String(o.id != null ? o.id : o))
            })).filter(o => String(o.value) !== 'all');
        }

        _postSelect2(url, page, search, extra) {
            const body = new URLSearchParams();
            body.set('page', String(page || 1));
            body.set('searchQuery', search || '');
            Object.keys(extra || {}).forEach(k => {
                const v = extra[k];
                if (v == null || v === '') return;
                if (Array.isArray(v)) {
                    if (!v.length) return;
                    body.set(k, v.map(String).join(','));
                } else {
                    body.set(k, String(v));
                }
            });
            return fetch(url, {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, this._csrfHeaders()),
                credentials: 'same-origin',
                body: body.toString()
            }).then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }).then(d => ({
                items: this._normSelect2Items(d),
                more: !!(d && d.pagination && d.pagination.more)
            }));
        }

        _loadRemote() {
            // Seed first page so existing static widgets have options immediately.
            if (this.data.checklistListUrl) {
                this._postSelect2(this.data.checklistListUrl, 1, '').then(d => {
                    if (d.items.length) this.checklists = d.items;
                }).catch(() => {});
            }
            if (this.data.usersListUrl) {
                this._postSelect2(this.data.usersListUrl, 1, '').then(d => {
                    if (d.items.length) this.users = d.items;
                }).catch(() => {});
            }
            if (this.data.assetsListUrl) {
                this._postSelect2(this.data.assetsListUrl, 1, '', { assets: 1 }).then(d => {
                    this.assets = d.items || [];
                }).catch(() => { this.assets = this.assets || []; });
            }
        }

        _renderAjaxMultiSelect(id, url, selectedValues, placeholder, extra) {
            const sel = (selectedValues || []).map(String).filter(Boolean);
            const seed = sel.map(v => {
                const known = (this.users || []).concat(this.checklists || []).concat(this.assets || [])
                    .find(i => String(i.value) === String(v));
                return known || { value: v, label: '#' + v };
            });
            const opts = seed.map(item => {
                const val = String(item.value);
                return `<label class="n8n-multiselect-option" data-label="${this._esc(item.label)}">
                    <input type="checkbox" value="${this._esc(val)}" checked>
                    <span class="n8n-multiselect-option-text">${this._esc(item.label)}</span>
                </label>`;
            }).join('');
            return `<div class="n8n-multiselect ae-ajax-ms" id="${id}" data-ajax-url="${this._esc(url || '')}" data-ajax-extra="${this._esc(JSON.stringify(extra || {}))}">
                <div class="n8n-multiselect-control" tabindex="0">
                    <div class="n8n-multiselect-tags"></div>
                    <i class="bi bi-chevron-down n8n-multiselect-caret"></i>
                </div>
                <div class="n8n-multiselect-dropdown">
                    <div class="n8n-multiselect-search">
                        <i class="bi bi-search"></i>
                        <input type="text" placeholder="${this._esc(placeholder || 'Search...')}">
                    </div>
                    <div class="n8n-multiselect-options">${opts}<div class="ae-ajax-sentinel" style="height:1px;"></div></div>
                </div>
            </div>`;
        }

        _renderAjaxSingleSelect(id, url, selectedValue, placeholder, extra) {
            const val = selectedValue != null && selectedValue !== '' ? String(selectedValue) : '';
            const known = (this.checklists || []).concat(this.users || []).concat(this.assets || [])
                .find(i => String(i.value) === val);
            const label = known ? known.label : (val ? ('#' + val) : (placeholder || 'Select...'));
            return `<div class="n8n-select ae-ajax-ss" id="${id}" data-ajax-url="${this._esc(url || '')}" data-ajax-extra="${this._esc(JSON.stringify(extra || {}))}">
                <div class="n8n-select-control" tabindex="0">
                    <span class="n8n-select-label">${this._esc(label)}</span>
                    <i class="bi bi-chevron-down"></i>
                </div>
                <input type="hidden" class="n8n-select-value" value="${this._esc(val)}">
                <div class="n8n-select-dropdown">
                    <div class="n8n-select-search"><i class="bi bi-search"></i><input type="text" placeholder="Search..."></div>
                    <div class="n8n-select-options"><div class="ae-ajax-sentinel" style="height:1px;"></div></div>
                </div>
            </div>`;
        }

        _initAjaxMultiSelect(root) {
            if (!root || root.dataset.ajaxBound) return;
            root.dataset.ajaxBound = '1';
            const url = root.dataset.ajaxUrl;
            if (!url) return this._initMultiSelect(root);

            let page = 0;
            let more = true;
            let loading = false;
            let search = '';
            let searchTimer = null;
            const optionsEl = root.querySelector('.n8n-multiselect-options');
            const searchInput = root.querySelector('.n8n-multiselect-search input');
            const self = this;
            let extra = {};
            try { extra = JSON.parse(root.dataset.ajaxExtra || '{}'); } catch (e) { extra = {}; }

            const currentExtra = () => {
                let fromData = {};
                try { fromData = JSON.parse(root.dataset.ajaxExtra || '{}'); } catch (e) { fromData = {}; }
                if (typeof root._aeGetExtra === 'function') {
                    try { return Object.assign({}, fromData, root._aeGetExtra() || {}); }
                    catch (e) { return fromData; }
                }
                return fromData;
            };

            const ensureOption = (item, checked) => {
                if (!optionsEl.querySelector(`input[type="checkbox"][value="${CSS.escape(String(item.value))}"]`)) {
                    const label = document.createElement('label');
                    label.className = 'n8n-multiselect-option';
                    label.dataset.label = (item.label || '').toLowerCase();
                    label.innerHTML = `<input type="checkbox" value="${self._esc(String(item.value))}" ${checked ? 'checked' : ''}>
                        <span class="n8n-multiselect-option-text">${self._esc(item.label)}</span>`;
                    const sentinel = optionsEl.querySelector('.ae-ajax-sentinel');
                    optionsEl.insertBefore(label, sentinel);
                    const cb = label.querySelector('input');
                    label.addEventListener('click', (e) => e.stopPropagation());
                    cb.addEventListener('change', () => {
                        renderTags();
                        if (typeof root._aeOnChange === 'function') root._aeOnChange();
                    });
                }
            };

            const renderTags = () => {
                const tags = root.querySelector('.n8n-multiselect-tags');
                const checked = Array.from(root.querySelectorAll('input[type="checkbox"]:checked'));
                if (checked.length === 0) {
                    tags.innerHTML = '<span class="n8n-multiselect-placeholder">Select...</span>';
                    return;
                }
                tags.innerHTML = checked.map(c => {
                    const label = c.closest('.n8n-multiselect-option').querySelector('.n8n-multiselect-option-text').textContent.trim();
                    return `<span class="n8n-multiselect-tag" data-value="${self._esc(c.value)}">${self._esc(label)}<i class="bi bi-x"></i></span>`;
                }).join('');
                tags.querySelectorAll('.n8n-multiselect-tag i').forEach(x => {
                    x.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const val = x.parentElement.dataset.value;
                        const cb = root.querySelector(`input[type="checkbox"][value="${CSS.escape(val)}"]`);
                        if (cb) cb.checked = false;
                        renderTags();
                        if (typeof root._aeOnChange === 'function') root._aeOnChange();
                    });
                });
            };

            const loadMore = (reset) => {
                if (!more && !reset) return;
                if (loading) return;
                loading = true;
                if (reset) {
                    page = 0;
                    more = true;
                    const keep = Array.from(root.querySelectorAll('input[type="checkbox"]:checked')).map(c => ({
                        value: c.value,
                        label: c.closest('.n8n-multiselect-option').querySelector('.n8n-multiselect-option-text').textContent.trim()
                    }));
                    optionsEl.innerHTML = '<div class="ae-ajax-sentinel" style="height:1px;"></div>';
                    keep.forEach(i => ensureOption(i, true));
                }
                const next = page + 1;
                this._postSelect2(url, next, search, currentExtra()).then(d => {
                    page = next;
                    more = d.more;
                    d.items.forEach(i => ensureOption(i, false));
                    if (!d.items.length && page === 1 && !root.querySelector('.n8n-multiselect-option')) {
                        const empty = document.createElement('div');
                        empty.className = 'n8n-multiselect-empty';
                        empty.textContent = 'No options available';
                        optionsEl.insertBefore(empty, optionsEl.querySelector('.ae-ajax-sentinel'));
                    }
                }).catch(() => { more = false; }).finally(() => { loading = false; renderTags(); });
            };

            root.aeReload = (clearChecked) => {
                if (clearChecked) {
                    root.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => { cb.checked = false; });
                }
                loadMore(true);
            };

            const control = root.querySelector('.n8n-multiselect-control');
            control.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasOpen = root.classList.contains('open');
                root.closest('#aeConfigBody')?.querySelectorAll('.n8n-select.open, .n8n-multiselect.open').forEach(s => s.classList.remove('open'));
                if (!wasOpen) {
                    root.classList.add('open');
                    if (page === 0) loadMore(true);
                    if (searchInput) setTimeout(() => searchInput.focus(), 30);
                }
            });
            optionsEl.addEventListener('scroll', () => {
                if (optionsEl.scrollTop + optionsEl.clientHeight >= optionsEl.scrollHeight - 40) loadMore(false);
            });
            if (searchInput) {
                searchInput.addEventListener('click', (e) => e.stopPropagation());
                searchInput.addEventListener('input', function () {
                    clearTimeout(searchTimer);
                    searchTimer = setTimeout(() => { search = this.value.trim(); loadMore(true); }, 250);
                });
            }
            if (!this._selectOutsideBound) {
                this._selectOutsideBound = true;
                document.addEventListener('click', (e) => {
                    if (!e.target.closest('.n8n-select') && !e.target.closest('.n8n-multiselect')) {
                        document.querySelectorAll('.n8n-select.open, .n8n-multiselect.open').forEach(s => s.classList.remove('open'));
                    }
                });
            }
            renderTags();
        }

        _initAjaxSingleSelect(root, onChange) {
            if (!root || root.dataset.ajaxBound) return;
            root.dataset.ajaxBound = '1';
            const url = root.dataset.ajaxUrl;
            if (!url) return this._initSingleSelect(root, onChange);

            let page = 0;
            let more = true;
            let loading = false;
            let search = '';
            let searchTimer = null;
            const optionsEl = root.querySelector('.n8n-select-options');
            const searchInput = root.querySelector('.n8n-select-search input');
            const labelEl = root.querySelector('.n8n-select-label');
            const valueEl = root.querySelector('.n8n-select-value');
            const self = this;
            let extra = {};
            try { extra = JSON.parse(root.dataset.ajaxExtra || '{}'); } catch (e) { extra = {}; }

            const addOption = (item) => {
                if (optionsEl.querySelector(`.n8n-select-option[data-value="${CSS.escape(String(item.value))}"]`)) return;
                const div = document.createElement('div');
                div.className = 'n8n-select-option';
                div.dataset.value = String(item.value);
                div.dataset.label = (item.label || '').toLowerCase();
                div.textContent = item.label;
                if (String(valueEl.value) === String(item.value)) div.classList.add('selected');
                div.addEventListener('click', (e) => {
                    e.stopPropagation();
                    valueEl.value = String(item.value);
                    labelEl.textContent = item.label;
                    optionsEl.querySelectorAll('.n8n-select-option').forEach(o => o.classList.remove('selected'));
                    div.classList.add('selected');
                    root.classList.remove('open');
                    if (onChange) onChange(item.value);
                });
                optionsEl.insertBefore(div, optionsEl.querySelector('.ae-ajax-sentinel'));
            };

            const loadMore = (reset) => {
                if ((!more && !reset) || loading) return;
                loading = true;
                if (reset) {
                    page = 0;
                    more = true;
                    optionsEl.innerHTML = '<div class="ae-ajax-sentinel" style="height:1px;"></div>';
                }
                const next = page + 1;
                this._postSelect2(url, next, search, extra).then(d => {
                    page = next;
                    more = d.more;
                    d.items.forEach(addOption);
                }).catch(() => { more = false; }).finally(() => { loading = false; });
            };

            root.querySelector('.n8n-select-control').addEventListener('click', (e) => {
                e.stopPropagation();
                const wasOpen = root.classList.contains('open');
                root.closest('#aeConfigBody')?.querySelectorAll('.n8n-select.open, .n8n-multiselect.open').forEach(s => s.classList.remove('open'));
                if (!wasOpen) {
                    root.classList.add('open');
                    if (page === 0) loadMore(true);
                    if (searchInput) setTimeout(() => searchInput.focus(), 30);
                }
            });
            optionsEl.addEventListener('scroll', () => {
                if (optionsEl.scrollTop + optionsEl.clientHeight >= optionsEl.scrollHeight - 40) loadMore(false);
            });
            if (searchInput) {
                searchInput.addEventListener('click', (e) => e.stopPropagation());
                searchInput.addEventListener('input', function () {
                    clearTimeout(searchTimer);
                    searchTimer = setTimeout(() => { search = this.value.trim(); loadMore(true); }, 250);
                });
            }
        }

        // ─── Auto Layout (layered / topological) ─────────────────────────
        _autoLayout() {
            if (this.nodes.length === 0) return;
            const nodeMap = {};
            this.nodes.forEach(n => { nodeMap[n.id] = n; });

            const inDegree = {};
            const outEdges = {};
            this.nodes.forEach(n => { inDegree[n.id] = 0; outEdges[n.id] = []; });
            this.edges.forEach(e => {
                if (nodeMap[e.source] && nodeMap[e.target]) {
                    inDegree[e.target] = (inDegree[e.target] || 0) + 1;
                    outEdges[e.source].push(e.target);
                }
            });

            const layers = [];
            let queue = this.nodes.filter(n => inDegree[n.id] === 0 || n.type === 'trigger').map(n => n.id);
            const visited = new Set();
            if (queue.length === 0 && this.nodes.length > 0) queue = [this.nodes[0].id];

            while (queue.length > 0) {
                const currentLayer = [];
                const nextQueue = [];
                queue.forEach(nId => {
                    if (visited.has(nId)) return;
                    visited.add(nId);
                    currentLayer.push(nId);
                    (outEdges[nId] || []).forEach(toId => {
                        inDegree[toId]--;
                        if (inDegree[toId] <= 0 && !visited.has(toId)) nextQueue.push(toId);
                    });
                });
                if (currentLayer.length) layers.push(currentLayer);
                queue = nextQueue;
            }
            const remaining = this.nodes.filter(n => !visited.has(n.id));
            if (remaining.length) layers.push(remaining.map(n => n.id));

            const hGap = 300;
            const vGap = 60;
            const startX = 120;
            const startY = 120;
            layers.forEach((layer, col) => {
                let y = startY;
                layer.forEach(nId => {
                    const node = nodeMap[nId];
                    if (node) {
                        node.h = this._nodeHeight(node);
                        node.x = startX + col * hGap;
                        node.y = y;
                        y += node.h + vGap;
                    }
                });
            });
        }

        // ─── Build HTML Layout ───────────────────────────────────────────
        _renderDrawerCategories() {
            return CATEGORIES.map(cat => {
                const items = cat.subtypes.map(st => {
                    const meta = CATALOG[st];
                    const color = TYPE_COLORS[meta.type];
                    return `<div class="n8n-drawer-item" data-subtype="${st}">
                        <div class="n8n-drawer-item-icon" style="background:${color}">
                            <i class="bi ${meta.icon}"></i>
                        </div>
                        <div class="n8n-drawer-item-info">
                            <div class="n8n-drawer-item-name">${this._esc(meta.label)}</div>
                            <div class="n8n-drawer-item-desc">${this._esc(meta.desc)}</div>
                        </div>
                        <div class="n8n-drawer-item-arrow">→</div>
                    </div>`;
                }).join('');
                return `<div class="n8n-drawer-category">
                    <div class="n8n-drawer-category-title">${this._esc(cat.title)}</div>
                    <div>${items}</div>
                </div>`;
            }).join('');
        }

        _buildLayout() {
            this.container.innerHTML = `
            <div class="n8n-editor-wrapper ae-wrapper ae-pipeline-layout" id="aeWrapper">
                <!-- Dual-Row Top Header Bar -->
                <header class="ae-header">
                    <div class="ae-header-top">
                        <div class="ae-header-left">
                            <a href="${this._esc(this.data.backUrl || '#')}" class="ae-header-back-btn" title="Back to Automations"><i class="bi bi-arrow-left"></i></a>
                            <div class="ae-brand-box">
                                <div class="ae-brand-title">Workflow Playground</div>
                                <div class="ae-brand-sub">Create, design and automate your workflows</div>
                            </div>
                            <div class="ae-header-divider"></div>
                            <div class="ae-name-wrap">
                                <span class="ae-name-title" id="aeName">${this._esc(this.name)}</span>
                                <button class="ae-name-edit-btn" id="aeSettingsBtn" title="Edit automation name & description"><i class="bi bi-pencil"></i></button>
                                <span class="ae-badge ae-badge-${this.status === 'published' ? 'active' : (this.status === 'paused' ? 'paused' : 'draft')}" id="aeStatusBadge">
                                    ${this._esc(this.status === 'published' ? 'Active' : (this.status === 'paused' ? 'Paused' : 'Draft'))}
                                </span>
                                <span class="ae-badge ae-badge-version">Version ${this._esc(this.data.version || '1')}</span>
                            </div>
                        </div>
                        <div class="ae-header-right">
                            <button class="ae-icon-btn" id="aeUndoBtn" title="Undo"><i class="bi bi-arrow-counterclockwise"></i></button>
                            <button class="ae-icon-btn" id="aeRedoBtn" title="Redo"><i class="bi bi-arrow-clockwise"></i></button>
                            <button class="ae-btn ae-btn-draft" id="aeSaveBtn"><i class="bi bi-save me-1"></i> Save Draft</button>
                            <button class="ae-btn ae-btn-publish" id="aePublishBtn"><i class="bi bi-rocket-takeoff me-1"></i> Publish</button>
                            <div class="ae-approved-badge"><i class="bi bi-check-circle-fill text-success"></i> Approved</div>
                            <div class="ae-user-meta">
                                <div class="ae-user-avatar">${this._esc((this.data.creator_name || 'U').charAt(0).toUpperCase())}</div>
                                <div class="ae-user-info">
                                    <div class="ae-user-name">Approved by ${this._esc(this.data.creator_name || 'User')}</div>
                                    <div class="ae-user-date">on ${this._esc(this.data.updated_at_fmt || 'Today')}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="ae-header-tabs">
                        <button class="ae-tab-btn active"><i class="bi bi-diagram-3 me-1"></i> Builder</button>
                        <a href="${this._esc(this.data.runsUrl || '#')}" class="ae-tab-btn"><i class="bi bi-journal-text me-1"></i> Instances</a>
                        <a href="${this._esc(this.data.runsUrl || '#')}" class="ae-tab-btn"><i class="bi bi-bar-chart me-1"></i> Analytics</a>
                        <a href="${this._esc(this.data.approvalsUrl || '#')}" class="ae-tab-btn"><i class="bi bi-person-check me-1"></i> Approvals</a>
                        <a href="${this._esc(this.data.runsUrl || '#')}" class="ae-tab-btn"><i class="bi bi-clock-history me-1"></i> History</a>
                    </div>
                </header>

                <!-- Workspace Area: Left Sidebar + Center Canvas + Right Inspector -->
                <div class="ae-workspace">
                    <!-- Left Sidebar Palette -->
                    <aside class="ae-left-sidebar" id="aeLeftSidebar">
                        <div class="ae-sidebar-scroll">
                            <!-- TRIGGERS -->
                            <div class="ae-cat-group">
                                <div class="ae-cat-title">TRIGGERS</div>
                                <div class="ae-cat-items">
                                    <div class="ae-palette-item" data-subtype="schedule">
                                        <div class="ae-palette-icon purple"><i class="bi bi-calendar-event"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Schedule</div>
                                            <div class="ae-palette-desc">Run on a schedule</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="checklist.submitted">
                                        <div class="ae-palette-icon green"><i class="bi bi-clipboard-check"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Checklist Submitted</div>
                                            <div class="ae-palette-desc">When checklist is submitted</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="asset">
                                        <div class="ae-palette-icon orange"><i class="bi bi-box-seam"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Asset Added/Updated</div>
                                            <div class="ae-palette-desc">When asset is added or updated</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="manual">
                                        <div class="ae-palette-icon orange"><i class="bi bi-play-circle"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Manual Trigger</div>
                                            <div class="ae-palette-desc">Start manually</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <button class="ae-more-btn" id="aeMoreTriggersBtn">+ More Triggers</button>
                                </div>
                            </div>

                            <!-- CONDITIONS -->
                            <div class="ae-cat-group">
                                <div class="ae-cat-title">CONDITIONS</div>
                                <div class="ae-cat-items">
                                    <div class="ae-palette-item" data-subtype="if_else">
                                        <div class="ae-palette-icon yellow"><i class="bi bi-diagram-2"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">If / Else</div>
                                            <div class="ae-palette-desc">Add conditions</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="wait_until">
                                        <div class="ae-palette-icon yellow"><i class="bi bi-hourglass-split"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Multi Condition</div>
                                            <div class="ae-palette-desc">Advanced conditions</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                </div>
                            </div>

                            <!-- ACTIONS -->
                            <div class="ae-cat-group">
                                <div class="ae-cat-title">ACTIONS</div>
                                <div class="ae-cat-items">
                                    <div class="ae-palette-item" data-subtype="assign_checklist">
                                        <div class="ae-palette-icon green"><i class="bi bi-clipboard-plus"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Assign Checklist</div>
                                            <div class="ae-palette-desc">Assign checklist to user</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="create_ticket">
                                        <div class="ae-palette-icon red"><i class="bi bi-ticket-perforated"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Create Ticket</div>
                                            <div class="ae-palette-desc">Create a new ticket</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="notify">
                                        <div class="ae-palette-icon blue"><i class="bi bi-bell"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Notify User</div>
                                            <div class="ae-palette-desc">Send in-app notification</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="http_request">
                                        <div class="ae-palette-icon green"><i class="bi bi-whatsapp"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">WhatsApp</div>
                                            <div class="ae-palette-desc">Send WhatsApp message</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="asset">
                                        <div class="ae-palette-icon green"><i class="bi bi-arrow-repeat"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Update Asset</div>
                                            <div class="ae-palette-desc">Update asset information</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <button class="ae-more-btn" id="aeMoreActionsBtn">+ More Actions</button>
                                </div>
                            </div>

                            <!-- FLOW CONTROL -->
                            <div class="ae-cat-group">
                                <div class="ae-cat-title">FLOW CONTROL</div>
                                <div class="ae-cat-items">
                                    <div class="ae-palette-item" data-subtype="wait">
                                        <div class="ae-palette-icon blue"><i class="bi bi-clock"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Wait / Delay</div>
                                            <div class="ae-palette-desc">Wait for a specific time</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="approval">
                                        <div class="ae-palette-icon purple"><i class="bi bi-person-check"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Approval</div>
                                            <div class="ae-palette-desc">Request approval</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="parallel">
                                        <div class="ae-palette-icon purple"><i class="bi bi-signpost-split"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Parallel Branch</div>
                                            <div class="ae-palette-desc">Execute in parallel</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                    <div class="ae-palette-item" data-subtype="merge">
                                        <div class="ae-palette-icon purple"><i class="bi bi-signpost-2"></i></div>
                                        <div class="ae-palette-info">
                                            <div class="ae-palette-name">Merge</div>
                                            <div class="ae-palette-desc">Merge branches</div>
                                        </div>
                                        <i class="bi bi-chevron-right ae-palette-arrow"></i>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </aside>

                    <!-- Center Canvas -->
                    <main class="n8n-canvas ae-center-canvas" id="aeCanvas">
                        <div class="n8n-canvas-transform" id="aeTransform">
                            <svg class="n8n-connections-svg" id="aeSvg">
                                <defs>
                                    <marker id="aeArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                                        <path d="M0,0 L8,4 L0,8 Z" fill="#64748b"/>
                                    </marker>
                                    <marker id="aeArrowHover" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                                        <path d="M0,0 L8,4 L0,8 Z" fill="#2563eb"/>
                                    </marker>
                                </defs>
                            </svg>
                            <div class="n8n-nodes-layer" id="aeNodesLayer"></div>
                        </div>

                        <div class="n8n-empty-state" id="aeEmptyState" style="display:${this.nodes.length === 0 ? 'block' : 'none'}">
                            <div class="n8n-empty-box" id="aeEmptyAdd">
                                <span class="plus-icon">+</span>
                            </div>
                            <div class="n8n-empty-text">Add first trigger from left sidebar…</div>
                        </div>

                        <!-- Floating Controls Bottom Left -->
                        <div class="ae-bottom-left-controls">
                            <div class="n8n-minimap" id="aeMinimap">
                                <div class="n8n-minimap-content" id="aeMinimapContent">
                                    <div class="n8n-minimap-viewport" id="aeMinimapViewport"></div>
                                </div>
                            </div>
                            <div class="n8n-canvas-controls">
                                <button class="n8n-ctrl-btn" id="aeMinimapToggle" title="Minimap"><i class="bi bi-pip"></i></button>
                                <button class="n8n-ctrl-btn" id="aeZoomOut" title="Zoom Out"><i class="bi bi-dash"></i></button>
                                <span class="n8n-zoom-display" id="aeZoomDisplay">100%</span>
                                <button class="n8n-ctrl-btn" id="aeZoomIn" title="Zoom In"><i class="bi bi-plus"></i></button>
                                <button class="n8n-ctrl-btn" id="aeFitView" title="Fit to View"><i class="bi bi-aspect-ratio"></i></button>
                                <button class="n8n-ctrl-btn" id="aeTidyUp" title="Auto Layout"><i class="bi bi-grid-3x3"></i></button>
                            </div>
                        </div>

                        <!-- Floating Status Bar -->
                        <div class="ae-bottom-status-bar">
                            <button class="ae-bottom-btn primary" id="aeTestRunBtn"><i class="bi bi-play-fill me-1"></i> Test Workflow</button>
                            <button class="ae-bottom-btn" id="aeValidateBtn"><i class="bi bi-patch-check me-1"></i> Validate</button>
                            <button class="ae-bottom-btn" id="aeExportBtn"><i class="bi bi-download me-1"></i> Export</button>
                            <div class="ae-validation-pill" id="aeValidatePillBtn">
                                <span class="ae-valid-icon"><i class="bi bi-check-circle-fill"></i></span>
                                <span class="ae-valid-text" id="aeValidText">Validation: No errors found</span>
                            </div>
                        </div>
                    </main>

                    <!-- Right Inspector Sidebar & Summary -->
                    <aside class="ae-right-sidebar" id="aeRightSidebar">
                        <div class="ae-right-header">
                            <div class="ae-right-title">Node Properties</div>
                            <button class="ae-right-close" id="aeConfigClose">&times;</button>
                        </div>
                        <div class="ae-right-content" id="aeConfigBody">
                            <div class="ae-no-node-selected">
                                <i class="bi bi-cursor"></i>
                                <p>Select a node on the canvas to configure its properties</p>
                            </div>
                        </div>

                        <!-- Workflow Summary Card -->
                        <div class="ae-workflow-summary" id="aeWorkflowSummary">
                            <div class="ae-summary-title">Workflow Summary <span class="ae-summary-status">${this._esc(this.status === 'published' ? 'Active' : 'Draft')}</span></div>
                            <div class="ae-summary-grid">
                                <div class="ae-summary-item"><span class="ae-sum-lbl">Total Nodes</span><span class="ae-sum-val" id="aeSumTotal">0</span></div>
                                <div class="ae-summary-item"><span class="ae-sum-lbl">Triggers</span><span class="ae-sum-val" id="aeSumTriggers">0</span></div>
                                <div class="ae-summary-item"><span class="ae-sum-lbl">Conditions</span><span class="ae-sum-val" id="aeSumConditions">0</span></div>
                                <div class="ae-summary-item"><span class="ae-sum-lbl">Actions</span><span class="ae-sum-val" id="aeSumActions">0</span></div>
                                <div class="ae-summary-item"><span class="ae-sum-lbl">Flow Controls</span><span class="ae-sum-val" id="aeSumFlows">0</span></div>
                                <div class="ae-summary-item"><span class="ae-sum-lbl">Est. Duration</span><span class="ae-sum-val" id="aeSumDuration">1d 2h 30m</span></div>
                            </div>
                            <div class="ae-summary-meta">
                                <div><span>Created By</span> <strong>${this._esc(this.data.creator_name || 'User')}</strong></div>
                                <div><span>Created On</span> <strong>${this._esc(this.data.created_at_fmt || '—')}</strong></div>
                                <div><span>Last Updated</span> <strong>${this._esc(this.data.updated_at_fmt || '—')}</strong></div>
                                <div><span>Version</span> <strong>${this._esc(this.data.version || '1')}</strong></div>
                            </div>
                        </div>
                    </aside>
                </div>

                <!-- Hidden drawer for extended searches -->
                <div class="n8n-drawer-overlay" id="aeDrawerOverlay"></div>
                <div class="n8n-drawer" id="aeDrawer">
                    <div class="n8n-drawer-header">
                        <div class="n8n-drawer-header-row">
                            <div class="n8n-drawer-title">What happens next?</div>
                        </div>
                        <div class="n8n-drawer-search">
                            <i class="bi bi-search search-icon"></i>
                            <input type="text" placeholder="Search triggers, actions, flow…" id="aeDrawerSearch">
                        </div>
                    </div>
                    <div class="n8n-drawer-body" id="aeDrawerBody">
                        ${this._renderDrawerCategories()}
                    </div>
                </div>

                <!-- Hidden Config Panel shim for backward compat -->
                <div class="n8n-config-panel" id="aeConfigPanel" style="display:none;"></div>

                <!-- Context Menu -->
                <div class="n8n-context-menu" id="aeContextMenu">
                    <div class="n8n-context-item" data-action="open"><i class="bi bi-box-arrow-up-right"></i> Open Node</div>
                    <div class="n8n-context-item" data-action="duplicate"><i class="bi bi-copy"></i> Duplicate</div>
                    <div class="n8n-context-divider"></div>
                    <div class="n8n-context-item danger" data-action="delete"><i class="bi bi-trash"></i> Delete</div>
                </div>

                <!-- Settings Modal -->
                <div class="n8n-modal-overlay" id="aeSettingsOverlay">
                    <div class="n8n-modal" role="dialog" aria-modal="true">
                        <div class="n8n-modal-header">
                            <div class="n8n-modal-title">
                                <span class="n8n-modal-title-icon"><i class="bi bi-sliders"></i></span>
                                Automation Settings
                            </div>
                            <button type="button" class="n8n-modal-close" id="aeSettingsClose" aria-label="Close">✕</button>
                        </div>
                        <div class="n8n-modal-body">
                            <div class="n8n-modal-field">
                                <label class="n8n-modal-label" for="aeSetName">Name <span class="n8n-modal-req">*</span></label>
                                <input type="text" class="n8n-modal-input" id="aeSetName" placeholder="e.g. Daily Vehicle Inspection" autocomplete="off">
                                <div class="n8n-modal-error" id="aeSetNameError">Please enter an automation name.</div>
                            </div>
                            <div class="n8n-modal-field">
                                <label class="n8n-modal-label" for="aeSetDesc">Description</label>
                                <textarea class="n8n-modal-input n8n-modal-textarea" id="aeSetDesc" rows="3" placeholder="Describe what this automation does"></textarea>
                            </div>
                        </div>
                        <div class="n8n-modal-footer">
                            <button type="button" class="n8n-modal-btn n8n-modal-btn-secondary" id="aeSettingsCancel">Cancel</button>
                            <button type="button" class="n8n-modal-btn n8n-modal-btn-primary" id="aeSettingsSave"><i class="bi bi-check-lg"></i> Apply</button>
                        </div>
                    </div>
                </div>

                <!-- Confirm Dialog -->
                <div class="n8n-modal-overlay" id="aeConfirmOverlay">
                    <div class="n8n-modal n8n-modal-sm" role="alertdialog" aria-modal="true">
                        <div class="n8n-modal-header">
                            <div class="n8n-modal-title">
                                <span class="n8n-modal-title-icon" id="aeConfirmIcon"><i class="bi bi-exclamation-triangle"></i></span>
                                <span id="aeConfirmTitle">Confirm</span>
                            </div>
                            <button type="button" class="n8n-modal-close" id="aeConfirmClose" aria-label="Close">✕</button>
                        </div>
                        <div class="n8n-modal-body">
                            <div class="n8n-modal-message" id="aeConfirmMessage"></div>
                        </div>
                        <div class="n8n-modal-footer">
                            <button type="button" class="n8n-modal-btn n8n-modal-btn-secondary" id="aeConfirmCancel">Cancel</button>
                            <button type="button" class="n8n-modal-btn n8n-modal-btn-primary" id="aeConfirmOk">Confirm</button>
                        </div>
                    </div>
                </div>

                <!-- Validation Modal -->
                <div class="n8n-modal-overlay" id="aeValidationOverlay">
                    <div class="n8n-modal n8n-modal-lg" role="alertdialog" aria-modal="true">
                        <div class="n8n-modal-header">
                            <div class="n8n-modal-title">
                                <span class="n8n-modal-title-icon danger"><i class="bi bi-exclamation-octagon"></i></span>
                                <span id="aeValidationHeading">Automation needs attention</span>
                            </div>
                            <button type="button" class="n8n-modal-close" id="aeValidationClose" aria-label="Close">✕</button>
                        </div>
                        <div class="n8n-modal-body">
                            <div class="n8n-validation-summary" id="aeValidationSummary"></div>
                            <div class="n8n-validation-intro">Fix the items below, then validate or publish again.</div>
                            <div class="n8n-validation-list" id="aeValidationList"></div>
                        </div>
                        <div class="n8n-modal-footer">
                            <button type="button" class="n8n-modal-btn n8n-modal-btn-primary" id="aeValidationOk"><i class="bi bi-check-lg"></i> Got it</button>
                        </div>
                    </div>
                </div>

                <!-- Toast host -->
                <div class="ae-toast-host" id="aeToastHost"></div>
            </div>`;

            // Cache DOM refs
            this.wrapper = this.container.querySelector('#aeWrapper');
            this.canvas = this.container.querySelector('#aeCanvas');
            this.transform = this.container.querySelector('#aeTransform');
            this.svg = this.container.querySelector('#aeSvg');
            this.nodesLayer = this.container.querySelector('#aeNodesLayer');
            this.minimap = this.container.querySelector('#aeMinimap');
            this.minimapContent = this.container.querySelector('#aeMinimapContent');
            this.minimapViewport = this.container.querySelector('#aeMinimapViewport');
            this.drawer = this.container.querySelector('#aeDrawer');
            this.drawerOverlay = this.container.querySelector('#aeDrawerOverlay');
            this.configPanel = this.container.querySelector('#aeConfigPanel');
            this.contextMenu = this.container.querySelector('#aeContextMenu');
            this.zoomDisplay = this.container.querySelector('#aeZoomDisplay');
            this.toastHost = this.container.querySelector('#aeToastHost');
        }

        // ─── Render Nodes ────────────────────────────────────────────────
        // ─── Render Nodes ────────────────────────────────────────────────
        _renderNodes() {
            this.nodesLayer.innerHTML = '';
            this.nodes.forEach(node => {
                node.h = this._nodeHeight(node);
                const meta = CATALOG[node.subtype] || { icon: 'bi-box', label: node.subtype };
                const outPorts = outPortsFor(node.subtype);

                const isCondition = node.type === 'condition' || node.subtype === 'if_else' || node.subtype === 'wait_until';
                const shapeClass = isCondition ? 'ae-shape-hexagon' : '';

                let themeClass = '';
                if (isCondition) {
                    themeClass = node.theme ? ('ae-theme-' + node.theme) : (node.name.includes('Score') ? 'ae-theme-blue' : (node.name.includes('after') ? 'ae-theme-red' : 'ae-theme-yellow'));
                } else if (node.id === 'n_1' || node.type === 'trigger') {
                    themeClass = 'ae-node-purple';
                } else if (node.id === 'n_2') {
                    themeClass = 'ae-node-blue';
                } else if (node.id === 'n_3' || node.id === 'n_10' || node.id === 'n_13') {
                    themeClass = 'ae-node-green';
                } else if (node.id === 'n_5') {
                    themeClass = 'ae-node-orange'; // Reminder is ORANGE in reference image!
                } else if (node.id === 'n_7' || node.id === 'n_11') {
                    themeClass = 'ae-node-purple'; // Escalate & Complete Workflow are PURPLE!
                } else if (node.subtype === 'create_ticket' || node.id === 'n_8' || node.id === 'n_12') {
                    themeClass = 'ae-node-red';
                } else if (node.id === 'n_14' || node.subtype === 'wait' || node.subtype === 'parallel') {
                    themeClass = 'ae-node-blue';
                } else {
                    themeClass = 'ae-node-purple';
                }

                const el = document.createElement('div');
                el.className = `n8n-node appearing ae-node ae-type-${node.type} ${shapeClass} ${themeClass}`;
                el.dataset.nodeId = node.id;
                el.style.left = node.x + 'px';
                el.style.top = node.y + 'px';
                el.style.width = node.w + 'px';
                el.style.minHeight = node.h + 'px';

                // Valid checkmark ONLY for specific completed nodes matching reference image
                const showBadge = ['n_1', 'n_3', 'n_10', 'n_11'].includes(node.id);
                const validCheck = showBadge ? '<div class="ae-node-valid-badge" title="Verified"><i class="bi bi-check-circle-fill"></i></div>' : '';

                // Input port
                const inputPort = this._hasInput(node)
                    ? `<div class="n8n-port input" data-port="input" data-node-id="${node.id}"></div>` : '';

                // Output ports
                let outputPorts = '';
                if (outPorts.length === 1) {
                    outputPorts = `<div class="n8n-port output" data-port="output" data-node-id="${node.id}" data-branch=""></div>`;
                } else if (outPorts.length > 1) {
                    outputPorts = outPorts.map((p, i) => {
                        const topPct = ((i + 1) / (outPorts.length + 1)) * 100;
                        return `<div class="n8n-port output ae-port-multi" data-port="output" data-node-id="${node.id}" data-branch="${p.key}" style="top:${topPct}%">
                            <span class="ae-port-label">${this._esc(p.label)}</span>
                        </div>`;
                    }).join('');
                }

                const subtitleText = node.subtitle || '';

                // Map exact icons matching reference image
                let nodeIcon = meta.icon;
                if (node.subtype === 'schedule') nodeIcon = 'bi-clock';
                else if (node.subtype === 'parallel') nodeIcon = 'bi-arrow-repeat';
                else if (node.subtype === 'assign_checklist') nodeIcon = 'bi-clipboard-check';
                else if (node.id === 'n_5') nodeIcon = 'bi-bell';
                else if (node.id === 'n_7') nodeIcon = 'bi-person-badge';
                else if (node.subtype === 'create_ticket') nodeIcon = 'bi-ticket-perforated';
                else if (node.subtype === 'asset') nodeIcon = 'bi-card-checklist';
                else if (node.id === 'n_11') nodeIcon = 'bi-check2-circle';
                else if (node.id === 'n_13') nodeIcon = 'bi-bell-fill';
                else if (node.subtype === 'wait') nodeIcon = 'bi-clock';

                if (isCondition) {
                    const theme = node.theme || (node.name.includes('Score') ? 'blue' : (node.name.includes('after') ? 'red' : 'yellow'));
                    const strokeColor = theme === 'blue' ? '#38bdf8' : (theme === 'red' ? '#f87171' : '#facc15');
                    const fillColor = theme === 'blue' ? '#f0f9ff' : (theme === 'red' ? '#fdf2f2' : '#fffbeb');
                    const sparkColor = theme === 'blue' ? '#0284c7' : (theme === 'red' ? '#dc2626' : '#d97706');

                    const hexW = node.w || 210;
                    const hexH = node.h || 85;
                    const cOff = 62; // Deep 62px chamfer offset for 6-sided equilateral diamond

                    el.innerHTML = `
                        ${validCheck}
                        <svg class="ae-hex-bg" viewBox="0 0 ${hexW} ${hexH}" preserveAspectRatio="none" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;">
                            <polygon points="${cOff},2 ${hexW - cOff},2 ${hexW - 2},${hexH / 2} ${hexW - cOff},${hexH - 2} ${cOff},${hexH - 2} 2,${hexH / 2}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="1.5"/>
                        </svg>
                        <div class="n8n-node-body" style="position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:4px 38px;background:transparent !important;">
                            <div style="color:${sparkColor};font-size:18px;line-height:1;margin-bottom:3px;display:flex;align-items:center;justify-content:center;">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="${sparkColor}">
                                    <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"/>
                                </svg>
                            </div>
                            <div class="n8n-node-title" style="text-align:center;font-size:12px;font-weight:700;color:#0f172a;line-height:1.2;margin-bottom:0;">
                                ${this._esc(node.name)}
                            </div>
                            ${(subtitleText && subtitleText !== 'If / Else' && subtitleText !== 'Wait Until') ? `<div class="n8n-node-subtitle" style="text-align:center;font-size:10.5px;color:#64748b;margin-top:2px;">${this._esc(subtitleText)}</div>` : ''}
                        </div>
                        ${inputPort}
                        ${outputPorts}
                    `;
                } else {
                    el.innerHTML = `
                        ${validCheck}
                        <div class="n8n-node-body">
                            <div class="n8n-node-icon-wrapper">
                                <i class="bi ${nodeIcon}"></i>
                            </div>
                            <div class="n8n-node-info">
                                <div class="n8n-node-title">${this._esc(node.name)}</div>
                                ${subtitleText ? `<div class="n8n-node-subtitle">${this._esc(subtitleText)}</div>` : ''}
                            </div>
                        </div>
                        ${inputPort}
                        ${outputPorts}
                    `;
                }

                this.nodesLayer.appendChild(el);
                node.el = el;
            });
            this._toggleEmptyState();
            this._updateSummary();
        }

        _typeBadgeClass(type) {
            return { trigger: 'green', condition: 'purple', action: 'orange', flow: 'blue' }[type] || 'blue';
        }

        _toggleEmptyState() {
            const empty = this.container.querySelector('#aeEmptyState');
            if (empty) empty.style.display = this.nodes.length === 0 ? 'block' : 'none';
        }

        _updateSummary() {
            const total = this.nodes.length;
            let triggers = 0, conditions = 0, actions = 0, flows = 0;
            this.nodes.forEach(n => {
                if (n.type === 'trigger') triggers++;
                else if (n.type === 'condition') conditions++;
                else if (n.type === 'action') actions++;
                else if (n.type === 'flow') flows++;
            });

            const sumTotal = this.container.querySelector('#aeSumTotal');
            const sumTriggers = this.container.querySelector('#aeSumTriggers');
            const sumConditions = this.container.querySelector('#aeSumConditions');
            const sumActions = this.container.querySelector('#aeSumActions');
            const sumFlows = this.container.querySelector('#aeSumFlows');

            if (sumTotal) sumTotal.textContent = total;
            if (sumTriggers) sumTriggers.textContent = triggers;
            if (sumConditions) sumConditions.textContent = conditions;
            if (sumActions) sumActions.textContent = actions;
            if (sumFlows) sumFlows.textContent = flows;

            const validPillText = this.container.querySelector('#aeValidText');
            if (validPillText) {
                const issues = this._validate();
                if (issues.length === 0) {
                    validPillText.innerHTML = 'Validation: <i class="bi bi-check-circle-fill text-success"></i> No errors found';
                } else {
                    validPillText.innerHTML = `Validation: <span class="text-danger"><i class="bi bi-exclamation-triangle-fill"></i> ${issues.length} issue(s)</span>`;
                }
            }
        }

        // ─── Port geometry ───────────────────────────────────────────────
        _outPortY(node, branchKey) {
            const ports = outPortsFor(node.subtype);
            if (ports.length <= 1) return node.y + node.h / 2;
            let idx = ports.findIndex(p => String(p.key) === String(branchKey));
            if (idx < 0) idx = 0;
            return node.y + node.h * ((idx + 1) / (ports.length + 1));
        }

        // ─── Port Connection Geometry ─────────────────────────────────────
        _getConnectionPoints(fromNode, toNode, branchKey) {
            let fromDir = 'bottom';
            let toDir = 'top';

            const fromSubtype = fromNode.subtype || '';
            const fromId = fromNode.id || '';
            const toId = toNode.id || '';

            if (fromId === 'n_4' || fromSubtype === 'if_else' && fromNode.name.includes('Submitted?')) {
                if (String(branchKey) === 'false') { fromDir = 'left'; toDir = 'top'; }
                else if (String(branchKey) === 'true') { fromDir = 'right'; toDir = 'top'; }
            } else if (fromId === 'n_6' || fromSubtype === 'if_else' && fromNode.name.includes('after')) {
                if (String(branchKey) === 'false') { fromDir = 'left'; toDir = 'top'; }
                else if (String(branchKey) === 'true') { fromDir = 'right'; toDir = 'top'; }
            } else if (fromId === 'n_9' || fromSubtype === 'wait_until') {
                if (String(branchKey) === 'true') { fromDir = 'right'; toDir = 'top'; }
                else if (String(branchKey) === 'false') { fromDir = 'bottom'; toDir = 'top'; }
            } else if (fromId === 'n_8' && toId === 'n_14') {
                fromDir = 'bottom'; toDir = 'left';
            } else if (fromId === 'n_14' && toId === 'n_11') {
                fromDir = 'right'; toDir = 'bottom';
            } else {
                const dx = toNode.x - fromNode.x;
                const dy = toNode.y - fromNode.y;
                if (Math.abs(dy) >= Math.abs(dx)) {
                    fromDir = dy >= 0 ? 'bottom' : 'top';
                    toDir = dy >= 0 ? 'top' : 'bottom';
                } else {
                    fromDir = dx >= 0 ? 'right' : 'left';
                    toDir = dx >= 0 ? 'left' : 'right';
                }
            }

            const getPoint = (node, dir) => {
                const w = node.w || 220;
                const h = node.el ? node.el.offsetHeight : (node.h || 75);
                if (dir === 'top') return { x: node.x + w / 2, y: node.y };
                if (dir === 'bottom') return { x: node.x + w / 2, y: node.y + h };
                if (dir === 'left') return { x: node.x, y: node.y + h / 2 };
                if (dir === 'right') return { x: node.x + w, y: node.y + h / 2 };
                return { x: node.x + w / 2, y: node.y + h };
            };

            const p1 = getPoint(fromNode, fromDir);
            const p2 = getPoint(toNode, toDir);

            return { p1, p2, fromDir, toDir };
        }

        // ─── Render Connections ──────────────────────────────────────────
        _renderConnections() {
            this.svg.querySelectorAll('.n8n-connection, .ae-edge-badge-group').forEach(p => p.remove());
            this.edges.forEach((edge, i) => {
                const fromNode = this._getNodeById(edge.source);
                const toNode = this._getNodeById(edge.target);
                if (!fromNode || !toNode) return;

                const fromH = fromNode.el ? fromNode.el.offsetHeight : fromNode.h;
                const toH = toNode.el ? toNode.el.offsetHeight : toNode.h;
                fromNode.h = fromH; toNode.h = toH;

                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.classList.add('n8n-connection');
                if (edge.dashed || fromNode.subtype === 'wait' || toNode.subtype === 'wait' || (fromNode.id === 'n_8' && toNode.id === 'n_14')) {
                    path.classList.add('dashed');
                }
                if (this.selectedEdge === edge) path.classList.add('selected');
                path.dataset.edgeIdx = i;
                path.setAttribute('marker-end', 'url(#aeArrow)');

                const { p1, p2, fromDir, toDir } = this._getConnectionPoints(fromNode, toNode, edge.branchKey);

                const d = this._orthoPath(p1, p2, fromDir, toDir);
                path.setAttribute('d', d);
                this.svg.appendChild(path);
                edge.el = path;

                path.addEventListener('mousedown', (e) => { e.stopPropagation(); });
                path.addEventListener('click', (e) => { e.stopPropagation(); this._selectEdge(edge); });

                // SVG Pill Label on connection line if branchKey is set
                if (edge.branchKey) {
                    const labelText = edge.branchKey === 'true' ? 'Yes' : (edge.branchKey === 'false' ? 'No' : edge.branchKey.toUpperCase());
                    const isGreen = ['true', 'yes', 'approved', 'success'].includes(String(edge.branchKey).toLowerCase());
                    const isRed = ['false', 'no', 'rejected', 'failure'].includes(String(edge.branchKey).toLowerCase());

                    let badgeX = (p1.x + p2.x) / 2;
                    let badgeY = (p1.y + p2.y) / 2;

                    if (fromDir === 'left') {
                        badgeX = p1.x - 24;
                        badgeY = p1.y;
                    } else if (fromDir === 'right') {
                        badgeX = p1.x + 24;
                        badgeY = p1.y;
                    } else if (fromDir === 'bottom' && toDir === 'top') {
                        badgeX = p1.x;
                        badgeY = p1.y + 16;
                    }

                    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                    g.classList.add('ae-edge-badge-group');
                    g.setAttribute('transform', `translate(${badgeX - 16}, ${badgeY - 10})`);

                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('width', '32');
                    rect.setAttribute('height', '18');
                    rect.setAttribute('rx', '9');
                    rect.setAttribute('fill', isGreen ? '#dcfce7' : (isRed ? '#fee2e2' : '#f1f5f9'));
                    rect.setAttribute('stroke', isGreen ? '#86efac' : (isRed ? '#fca5a5' : '#cbd5e1'));
                    rect.setAttribute('stroke-width', '1');

                    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    text.setAttribute('x', '16');
                    text.setAttribute('y', '12.5');
                    text.setAttribute('text-anchor', 'middle');
                    text.setAttribute('font-size', '9.5');
                    text.setAttribute('font-weight', '700');
                    text.setAttribute('fill', isGreen ? '#15803d' : (isRed ? '#b91c1c' : '#475569'));
                    text.textContent = labelText;

                    g.appendChild(rect);
                    g.appendChild(text);
                    this.svg.appendChild(g);
                }
            });
        }

        _orthoPath(p1, p2, fromDir, toDir) {
            const x1 = p1.x, y1 = p1.y;
            const x2 = p2.x, y2 = p2.y;
            const r = 8;

            if (fromDir === 'bottom' && toDir === 'top') {
                if (Math.abs(x1 - x2) < 4) {
                    return `M ${x1},${y1} L ${x2},${y2}`;
                }
                const midY = y1 + (y2 - y1) / 2;
                const sx = x2 > x1 ? 1 : -1;
                return `M ${x1},${y1} L ${x1},${midY - r} Q ${x1},${midY} ${x1 + sx * r},${midY} L ${x2 - sx * r},${midY} Q ${x2},${midY} ${x2},${midY + r} L ${x2},${y2}`;
            }

            if (fromDir === 'left' && toDir === 'top') {
                const cornerY = y1;
                const cornerX = x2;
                const sy = y2 > y1 ? 1 : -1;
                return `M ${x1},${y1} L ${cornerX + r},${cornerY} Q ${cornerX},${cornerY} ${cornerX},${cornerY + sy * r} L ${x2},${y2}`;
            }

            if (fromDir === 'right' && toDir === 'top') {
                const cornerY = y1;
                const cornerX = x2;
                const sy = y2 > y1 ? 1 : -1;
                return `M ${x1},${y1} L ${cornerX - r},${cornerY} Q ${cornerX},${cornerY} ${cornerX},${cornerY + sy * r} L ${x2},${y2}`;
            }

            if (fromDir === 'bottom' && toDir === 'left') {
                const cornerX = x1;
                const cornerY = y2;
                return `M ${x1},${y1} L ${cornerX},${cornerY - r} Q ${cornerX},${cornerY} ${cornerX + r},${cornerY} L ${x2},${y2}`;
            }

            if (fromDir === 'right' && toDir === 'bottom') {
                const cornerY = y1;
                const cornerX = x2;
                return `M ${x1},${y1} L ${cornerX - r},${cornerY} Q ${cornerX},${cornerY} ${cornerX},${cornerY - r} L ${x2},${y2}`;
            }

            // Fallback orthogonal path
            const dx = x2 - x1;
            const dy = y2 - y1;
            if (Math.abs(dx) > Math.abs(dy)) {
                const midX = x1 + dx / 2;
                return `M ${x1},${y1} L ${midX},${y1} L ${midX},${y2} L ${x2},${y2}`;
            } else {
                const midY = y1 + dy / 2;
                return `M ${x1},${y1} L ${x1},${midY} L ${x2},${midY} L ${x2},${y2}`;
            }
        }

        _selectEdge(edge) {
            this._deselectAll();
            this.selectedEdge = edge;
            if (edge.el) edge.el.classList.add('selected');
        }

        _updateTransform() {
            this.transform.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
            this.zoomDisplay.textContent = Math.round(this.zoom * 100) + '%';
        }

        // ─── Fit to View ─────────────────────────────────────────────────
        _fitToView() {
            if (this.nodes.length === 0) { this.zoom = 1; this.panX = 0; this.panY = 0; this._updateTransform(); return; }
            const rect = this.canvas.getBoundingClientRect();
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            this.nodes.forEach(n => {
                minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
                maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
            });
            const graphW = maxX - minX + 120;
            const graphH = maxY - minY + 120;
            this.zoom = Math.max(Math.min(rect.width / graphW, rect.height / graphH, 1.2), 0.2);
            this.panX = (rect.width - graphW * this.zoom) / 2 - minX * this.zoom + 60;
            this.panY = (rect.height - graphH * this.zoom) / 2 - minY * this.zoom + 60;
            this._updateTransform();
            this._updateMinimap();
        }

        // ─── Minimap ─────────────────────────────────────────────────────
        _updateMinimap() {
            if (!this.minimapVisible || this.nodes.length === 0) return;
            const mmW = 200, mmH = 140;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            this.nodes.forEach(n => {
                minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
                maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
            });
            const pad = 40;
            minX -= pad; minY -= pad; maxX += pad; maxY += pad;
            const graphW = maxX - minX, graphH = maxY - minY;
            const scale = Math.min(mmW / graphW, mmH / graphH);

            this.minimapContent.querySelectorAll('.n8n-minimap-node').forEach(e => e.remove());
            this.nodes.forEach(n => {
                const dot = document.createElement('div');
                dot.className = 'n8n-minimap-node';
                dot.style.left = ((n.x - minX) * scale) + 'px';
                dot.style.top = ((n.y - minY) * scale) + 'px';
                dot.style.width = (n.w * scale) + 'px';
                dot.style.height = (n.h * scale) + 'px';
                dot.style.background = TYPE_COLORS[n.type] || '#334155';
                this.minimapContent.appendChild(dot);
            });

            const rect = this.canvas.getBoundingClientRect();
            const vpL = (-this.panX / this.zoom - minX) * scale;
            const vpT = (-this.panY / this.zoom - minY) * scale;
            const vpW = (rect.width / this.zoom) * scale;
            const vpH = (rect.height / this.zoom) * scale;
            this.minimapViewport.style.left = Math.max(0, vpL) + 'px';
            this.minimapViewport.style.top = Math.max(0, vpT) + 'px';
            this.minimapViewport.style.width = Math.min(vpW, mmW) + 'px';
            this.minimapViewport.style.height = Math.min(vpH, mmH) + 'px';
        }

        _setZoom(newZoom) {
            const rect = this.canvas.getBoundingClientRect();
            const cx = rect.width / 2, cy = rect.height / 2;
            const oldZoom = this.zoom;
            this.zoom = Math.min(Math.max(newZoom, 0.15), 3);
            const ratio = this.zoom / oldZoom;
            this.panX = cx - (cx - this.panX) * ratio;
            this.panY = cy - (cy - this.panY) * ratio;
            this._updateTransform();
            this._updateMinimap();
        }

        // ─── Toast ───────────────────────────────────────────────────────
        _toast(message, type) {
            type = type || 'info';
            const t = document.createElement('div');
            t.className = 'ae-toast ae-toast-' + type;
            const icon = type === 'success' ? 'bi-check-circle-fill'
                : type === 'error' ? 'bi-x-circle-fill'
                : type === 'warning' ? 'bi-exclamation-triangle-fill' : 'bi-info-circle-fill';
            t.innerHTML = `<i class="bi ${icon}"></i><span>${this._esc(message)}</span>`;
            this.toastHost.appendChild(t);
            requestAnimationFrame(() => t.classList.add('show'));
            setTimeout(() => {
                t.classList.remove('show');
                setTimeout(() => t.remove(), 300);
            }, 3200);
        }

        // ─── Custom Single Select (ported from n8n) ──────────────────────
        _renderSingleSelect(id, items, selectedValue, opts) {
            opts = opts || {};
            const placeholder = opts.placeholder || '-- Select --';
            const allowEmpty = opts.allowEmpty !== false;
            const sel = String(selectedValue == null ? '' : selectedValue);
            const selectedItem = items.find(i => String(i.value) === sel);
            const labelText = selectedItem ? selectedItem.label : placeholder;
            const labelClass = selectedItem ? '' : ' placeholder';

            const optionsHtml = items.map(item => {
                const val = String(item.value);
                const active = val === sel ? ' active' : '';
                return `<div class="n8n-select-option${active}" data-value="${this._esc(val)}" data-label="${this._esc(item.label).toLowerCase()}">${this._esc(item.label)}</div>`;
            }).join('');

            const emptyOption = allowEmpty
                ? `<div class="n8n-select-option${!sel ? ' active' : ''}" data-value="" data-label="">${this._esc(placeholder)}</div>`
                : '';

            return `
                <div class="n8n-select" id="${id}" data-placeholder="${this._esc(placeholder)}">
                    <input type="hidden" class="n8n-select-value" value="${this._esc(sel)}">
                    <div class="n8n-select-control" tabindex="0">
                        <span class="n8n-select-label${labelClass}">${this._esc(labelText)}</span>
                        <i class="bi bi-chevron-down n8n-select-caret"></i>
                    </div>
                    <div class="n8n-select-dropdown">
                        <div class="n8n-select-search">
                            <i class="bi bi-search"></i>
                            <input type="text" placeholder="Search...">
                        </div>
                        <div class="n8n-select-options">${emptyOption}${optionsHtml}</div>
                    </div>
                </div>`;
        }

        _initSingleSelect(root, onChange) {
            if (!root) return;
            const control = root.querySelector('.n8n-select-control');
            const hidden = root.querySelector('.n8n-select-value');
            const labelEl = root.querySelector('.n8n-select-label');
            const search = root.querySelector('.n8n-select-search input');
            const options = root.querySelectorAll('.n8n-select-option');
            const placeholder = root.dataset.placeholder || '-- Select --';
            const close = () => root.classList.remove('open');

            const setValue = (val, text) => {
                hidden.value = val;
                labelEl.textContent = text || placeholder;
                labelEl.classList.toggle('placeholder', !val);
                options.forEach(o => o.classList.toggle('active', o.dataset.value === val));
                if (typeof onChange === 'function') onChange(val);
            };

            control.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasOpen = root.classList.contains('open');
                root.closest('#aeConfigBody')?.querySelectorAll('.n8n-select.open, .n8n-multiselect.open').forEach(s => s.classList.remove('open'));
                if (!wasOpen) {
                    root.classList.add('open');
                    if (search) { search.value = ''; options.forEach(o => o.style.display = ''); setTimeout(() => search.focus(), 30); }
                }
            });
            options.forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setValue(opt.dataset.value, opt.textContent.trim());
                    close();
                });
            });
            if (search) {
                search.addEventListener('click', (e) => e.stopPropagation());
                search.addEventListener('input', function () {
                    const q = this.value.toLowerCase();
                    options.forEach(o => { o.style.display = (o.dataset.label || '').includes(q) ? '' : 'none'; });
                });
            }
            if (!this._selectOutsideBound) {
                this._selectOutsideBound = true;
                document.addEventListener('click', (e) => {
                    if (!e.target.closest('.n8n-select') && !e.target.closest('.n8n-multiselect')) {
                        document.querySelectorAll('.n8n-select.open, .n8n-multiselect.open').forEach(s => s.classList.remove('open'));
                    }
                });
            }
        }

        _getSelectVal(scope, id) {
            const input = scope.querySelector(`#${id} .n8n-select-value`);
            return input ? input.value : '';
        }

        // ─── Custom Multi Select ─────────────────────────────────────────
        _renderMultiSelect(id, items, selectedValues, placeholder) {
            const sel = (selectedValues || []).map(String);
            const opts = items.map(item => {
                const val = String(item.value);
                const checked = sel.includes(val) ? 'checked' : '';
                return `<label class="n8n-multiselect-option" data-label="${this._esc(item.label)}">
                    <input type="checkbox" value="${this._esc(val)}" ${checked}>
                    <span class="n8n-multiselect-option-text">${this._esc(item.label)}</span>
                </label>`;
            }).join('');
            const empty = items.length === 0 ? '<div class="n8n-multiselect-empty">No options available</div>' : '';
            return `<div class="n8n-multiselect" id="${id}">
                <div class="n8n-multiselect-control" tabindex="0">
                    <div class="n8n-multiselect-tags"></div>
                    <i class="bi bi-chevron-down n8n-multiselect-caret"></i>
                </div>
                <div class="n8n-multiselect-dropdown">
                    <div class="n8n-multiselect-search">
                        <i class="bi bi-search"></i>
                        <input type="text" placeholder="${this._esc(placeholder || 'Search...')}">
                    </div>
                    <div class="n8n-multiselect-options">${opts}${empty}</div>
                </div>
            </div>`;
        }

        _initMultiSelect(root) {
            if (!root) return;
            const control = root.querySelector('.n8n-multiselect-control');
            const tags = root.querySelector('.n8n-multiselect-tags');
            const search = root.querySelector('.n8n-multiselect-search input');
            const options = root.querySelectorAll('.n8n-multiselect-option');
            const self = this;

            const renderTags = () => {
                const checked = Array.from(root.querySelectorAll('input[type="checkbox"]:checked'));
                if (checked.length === 0) {
                    tags.innerHTML = '<span class="n8n-multiselect-placeholder">Select...</span>';
                    return;
                }
                tags.innerHTML = checked.map(c => {
                    const label = c.closest('.n8n-multiselect-option').querySelector('.n8n-multiselect-option-text').textContent.trim();
                    return `<span class="n8n-multiselect-tag" data-value="${self._esc(c.value)}">${self._esc(label)}<i class="bi bi-x"></i></span>`;
                }).join('');
                tags.querySelectorAll('.n8n-multiselect-tag i').forEach(x => {
                    x.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const val = x.parentElement.dataset.value;
                        const cb = root.querySelector(`input[type="checkbox"][value="${val}"]`);
                        if (cb) cb.checked = false;
                        renderTags();
                        if (typeof root._aeOnChange === 'function') root._aeOnChange();
                    });
                });
            };

            control.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasOpen = root.classList.contains('open');
                root.closest('#aeConfigBody')?.querySelectorAll('.n8n-select.open, .n8n-multiselect.open').forEach(s => s.classList.remove('open'));
                if (!wasOpen) { root.classList.add('open'); if (search) setTimeout(() => search.focus(), 30); }
            });
            options.forEach(opt => {
                opt.addEventListener('click', (e) => e.stopPropagation());
                const cb = opt.querySelector('input[type="checkbox"]');
                if (cb) cb.addEventListener('change', () => {
                    renderTags();
                    if (typeof root._aeOnChange === 'function') root._aeOnChange();
                });
            });
            if (search) {
                search.addEventListener('click', (e) => e.stopPropagation());
                search.addEventListener('input', function () {
                    const q = this.value.toLowerCase();
                    options.forEach(opt => { opt.style.display = (opt.dataset.label || '').toLowerCase().includes(q) ? '' : 'none'; });
                });
            }
            renderTags();
        }

        _getMultiVal(scope, id) {
            const root = scope.querySelector('#' + id);
            if (!root) return [];
            return Array.from(root.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
        }

        // ─── Drawer ──────────────────────────────────────────────────────
        _openDrawer() {
            this.drawerOpen = true;
            this.drawer.classList.add('open');
            this.drawerOverlay.classList.add('open');
            setTimeout(() => { const s = this.container.querySelector('#aeDrawerSearch'); if (s) s.focus(); }, 300);
        }
        _closeDrawer() {
            this.drawerOpen = false;
            this.drawer.classList.remove('open');
            this.drawerOverlay.classList.remove('open');
        }

        _addNode(subtype) {
            const meta = CATALOG[subtype];
            if (!meta) return;

            // Position: after selected node, else canvas center.
            const rect = this.canvas.getBoundingClientRect();
            let x, y;
            const anchor = this.selectedNodes[0];
            if (anchor) {
                x = anchor.x + 300;
                y = anchor.y;
            } else {
                x = (rect.width / 2 - this.panX) / this.zoom - 100;
                y = (rect.height / 2 - this.panY) / this.zoom - 37;
            }

            const node = {
                id: this._uid('n'),
                type: meta.type,
                subtype: subtype,
                name: meta.label,
                config: this._defaultConfig(subtype),
                x: Math.round(x / 20) * 20,
                y: Math.round(y / 20) * 20,
                w: 200, h: 75
            };
            node.h = this._nodeHeight(node);

            // Auto-connect from selected node's default/first output.
            const connectFrom = anchor;
            this.nodes.push(node);

            if (connectFrom && connectFrom.subtype !== 'end') {
                const ports = outPortsFor(connectFrom.subtype);
                const branchKey = ports.length ? ports[0].key : null;
                const exists = this.edges.some(e => e.source === connectFrom.id && String(e.branchKey) === String(branchKey));
                if (!exists && this._hasInput(node)) {
                    this.edges.push({ id: this._uid('e'), source: connectFrom.id, target: node.id, branchKey: branchKey });
                }
            }

            this._renderNodes();
            this._renderConnections();
            this._bindNodeEvents();
            this._selectNode(node);
            this._updateMinimap();
            this._closeDrawer();
            this._openConfig(node);
        }

        _defaultConfig(subtype) {
            switch (subtype) {
                case 'schedule':    return { frequency: 'daily', time: '09:00', timezone: this.timezones[0] ? this.timezones[0].value : 'UTC', cron: '' };
                case 'assign_checklist': return { checklist_id: '', assignee_mode: 'users', assignment_type: '1', role_ids: [], user_ids: [], due_hours: 24 };
                case 'notify':      return { channel: 'email', recipient_mode: 'users', content_mode: 'custom', email_template_id: '', push_template_id: '', template_id: '', subject: '', body: '', user_ids: [], role_ids: [], attachments: [] };
                case 'create_ticket': return { subject: '', description: '', priority: 'medium', owner_mode: 'asset_owner' };
                case 'if_else':     return { logic: 'and', rules: [{ field: '', op: 'eq', value: '' }] };
                case 'wait':        return { duration_value: 1, duration_unit: 'hours', value: 1, unit: 'hours' };
                case 'wait_until':  return { event: 'checklist.submitted', timeout_value: 24, timeout_unit: 'hours' };
                case 'for_each':    return { collection: 'assigned_task_ids', items_path: 'assigned_task_ids', vehicles_only: false };
                case 'approval':    return { approver_mode: 'users', user_ids: [], role_ids: [], approver_user_ids: [], message: '', timeout: 48, timeout_value: 48, timeout_unit: 'hours' };
                case 'http_request': return { method: 'POST', url: '', body: '', timeout_seconds: 30, fail_on_error: true };
                case 'dedupe':      return { key_template: '', key: '', ttl_seconds: 3600, skip_silently: true };
                case 'record': return { source: '', events: [], actions: ['created', 'updated'], changed_fields: [], checklist_ids: [], user_ids: [], store_ids: [], asset_ids: [], location_ids: [], priorities: [], department_ids: [], particular_ids: [], issue_ids: [], document_ids: [], role_ids: [], task_ids: [], zone_ids: [] };
                case 'checklist.submitted': return { checklist_ids: [], user_ids: [], store_ids: [], asset_ids: [], location_ids: [] };
                case 'ticket': return { events: ['created', 'updated', 'closed'], priorities: [], store_ids: [], asset_ids: [], location_ids: [], department_ids: [], particular_ids: [], issue_ids: [] };
                case 'ticket.created':
                case 'ticket.updated':
                case 'ticket.closed': return { priorities: [], store_ids: [], asset_ids: [], location_ids: [], department_ids: [], particular_ids: [], issue_ids: [] };
                case 'asset': return { actions: ['created', 'updated'], changed_fields: [], asset_ids: [] };
                case 'asset.changed': return { asset_ids: [] };
                case 'location': return { actions: ['created', 'updated'], changed_fields: [], location_ids: [] };
                case 'location.changed': return { location_ids: [] };
                default:            return {};
            }
        }

        // ─── Config Panel ────────────────────────────────────────────────
        _openConfig(node) {
            this.configNode = node;
            this.configOpen = true;
            const meta = CATALOG[node.subtype] || { icon: 'bi-box', label: node.subtype };
            const color = TYPE_COLORS[node.type] || '#334155';

            const iconEl = this.container.querySelector('#aeConfigIcon');
            iconEl.style.background = color;
            iconEl.innerHTML = `<i class="bi ${meta.icon}"></i>`;
            this.container.querySelector('#aeConfigName').textContent = node.name;

            const body = this.container.querySelector('#aeConfigBody');
            body.innerHTML = `
                <style>
                .ae-cfg-input { width:100%; font-size:13px; color:var(--n8n-text-primary); padding:8px 12px; background:#fff; border:1px solid #e8e8e8; border-radius:6px; min-height:38px; outline:none; font-family:var(--n8n-font); }
                .ae-cfg-input:focus { border-color:var(--n8n-selected-color); }
                textarea.ae-cfg-input { min-height:72px; resize:vertical; }
                .ae-help { font-size:12px; color:var(--n8n-text-muted); background:#fafafa; border:1px solid #eee; border-radius:6px; padding:10px 12px; line-height:1.5; }
                .ae-rule-value-slot, .ae-rule-value-box { min-width:0; width:100%; }
                .ae-rule-value-box { display:flex; flex-direction:column; gap:6px; }
                .ae-rule-value-extra .n8n-select, .ae-rule-value-extra .ae-rule-value-wrap { width:100%; }
                .ae-icon-btn { border:1px solid #e8e8e8; background:#fff; border-radius:6px; height:34px; cursor:pointer; color:#6b6b6b; }
                .ae-icon-btn:hover { background:#f5f5f5; color:#111; }
                .ae-inline { display:flex; gap:8px; }
                .ae-danger-btn { background:#dc2626; color:#fff; border:1px solid #dc2626; padding:8px 14px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; }
                .ae-danger-btn:hover { background:#b91c1c; }
                </style>
                <div id="aeParamsTab">${this._renderParams(node)}</div>
                <div id="aeSettingsTab" style="display:none;">
                    <div class="n8n-config-section">
                        <div class="n8n-config-section-title">Node</div>
                        <div class="n8n-config-field">
                            <label class="n8n-config-label">Name <span class="n8n-required">*</span></label>
                            <input type="text" class="ae-cfg-input" id="aeSetNodeName" value="${this._esc(node.name)}">
                        </div>
                        <div class="n8n-config-field">
                            <label class="n8n-config-label">Type</label>
                            <div class="n8n-config-value"><span class="n8n-config-badge ${this._typeBadgeClass(node.type)}">${this._esc(TYPE_LABELS[node.type])}</span> &nbsp; ${this._esc(humanLabel(node.subtype))}</div>
                        </div>
                        <div class="n8n-config-field">
                            <label class="n8n-config-label">Node ID</label>
                            <div class="n8n-config-value" style="font-family:monospace;">${this._esc(node.id)}</div>
                        </div>
                    </div>
                    <div class="n8n-config-section">
                        <div class="n8n-config-section-title">Danger Zone</div>
                        <button class="ae-danger-btn" id="aeDeleteNodeBtn"><i class="bi bi-trash"></i> Delete Node</button>
                    </div>
                </div>
            `;

            // Init selects/multiselects present in params
            this._initConfigWidgets(body, node);

            // Tabs default to Parameters
            this.container.querySelectorAll('.n8n-config-tab').forEach(t => t.classList.remove('active'));
            const paramTab = this.container.querySelector('.n8n-config-tab[data-ctab="params"]');
            if (paramTab) paramTab.classList.add('active');
            this.container.querySelector('#aeParamsTab').style.display = 'block';
            this.container.querySelector('#aeSettingsTab').style.display = 'none';

            // Settings actions
            const nameInput = body.querySelector('#aeSetNodeName');
            if (nameInput) {
                nameInput.addEventListener('input', () => {
                    node.name = nameInput.value;
                    this.container.querySelector('#aeConfigName').textContent = node.name;
                    const titleEl = node.el && node.el.querySelector('.n8n-node-title');
                    if (titleEl) titleEl.textContent = node.name;
                });
            }
            const delBtn = body.querySelector('#aeDeleteNodeBtn');
            if (delBtn) delBtn.addEventListener('click', () => this._deleteNodeConfirm(node));

            this.configPanel.classList.add('open');
        }

        _closeConfig() {
            if (this.configNode) {
                const body = this.container.querySelector('#aeConfigBody');
                if (body) this._readParams(this.configNode, body);
            }
            this.configOpen = false;
            this.configPanel.classList.remove('open');
            this.configNode = null;
        }

        _initConfigWidgets(body, node) {
            body.querySelectorAll('.n8n-select').forEach(el => {
                // #cfgFrequency is initialized by _bindConditionalFields (it also
                // toggles dependent fields), so skip it here to avoid double-binding.
                if (el.id === 'cfgFrequency') return;
                if (el.id === 'cfgChannel' || el.id === 'cfgContentMode' || el.id === 'cfgRecipientMode') return;
                if (el.id === 'cfgRecordSource') {
                    this._initSingleSelect(el, () => {
                        this._readParams(node, body);
                        const src = this._getSelectVal(body, 'cfgRecordSource') || '';
                        node.config.source = src;
                        node.config.changed_fields = [];
                        node.config.store_ids = [];
                        node.config.asset_ids = [];
                        node.config.location_ids = [];
                        node.config.department_ids = [];
                        node.config.particular_ids = [];
                        node.config.issue_ids = [];
                        node.config.priorities = [];
                        if (src === 'ticket') {
                            node.config.events = ['created', 'updated', 'closed'];
                            node.config.actions = [];
                        } else if (src === 'checklist') {
                            node.config.events = ['created', 'updated'];
                            node.config.actions = [];
                        } else if (src === 'task') {
                            node.config.events = [];
                            node.config.actions = ['updated', 'in_progress', 'submitted'];
                        } else {
                            node.config.events = [];
                            node.config.actions = ['created', 'updated'];
                        }
                        this._rerenderParams(node, true);
                    });
                    return;
                }
                if (el.classList.contains('ae-ajax-ss')) {
                    this._initAjaxSingleSelect(el, () => {
                        if (el.id === 'cfgDedupeAsset') {
                            const val = this._getSelectVal(body, 'cfgDedupeAsset');
                            const input = body.querySelector('#cfgDedupeKey');
                            if (val && input) {
                                input.value = input.value
                                    ? (input.value.replace(/-+$/, '') + '-' + String(val))
                                    : String(val);
                            }
                        }
                        this._readParams(node, body);
                    });
                } else {
                    this._initSingleSelect(el, () => this._readParams(node, body));
                }
            });
            body.querySelectorAll('.n8n-multiselect').forEach(el => {
                if (el.classList.contains('ae-ajax-ms')) this._initAjaxMultiSelect(el);
                else this._initMultiSelect(el);
                if (el.closest('#aeRules')) {
                    el._aeOnChange = () => this._readParams(node, body);
                }
            });
            // Toggles
            body.querySelectorAll('.ae-toggle').forEach(t => {
                t.addEventListener('click', () => { t.classList.toggle('active'); this._readParams(node, body); });
            });
            // Conditional visibility bindings
            this._bindConditionalFields(body, node);
            // if_else rule add/remove
            const addRuleBtn = body.querySelector('#aeAddRule');
            if (addRuleBtn) {
                addRuleBtn.addEventListener('click', () => {
                    this._readParams(node, body);
                    node.config.rules = Array.isArray(node.config.rules) ? node.config.rules.slice() : [];
                    node.config.rules.push({ field: '', op: 'eq', value: '' });
                    this._rerenderParams(node, true);
                });
            }
            body.querySelectorAll('.ae-del-rule').forEach(btn => {
                btn.addEventListener('click', () => {
                    this._readParams(node, body);
                    const idx = parseInt(btn.dataset.idx, 10);
                    if (node.config.rules && node.config.rules.length > 1) {
                        node.config.rules.splice(idx, 1);
                        this._rerenderParams(node, true);
                    }
                });
            });
            // Dedupe token chips
            body.querySelectorAll('.ae-token-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const input = body.querySelector('#cfgDedupeKey');
                    if (!input) return;
                    const token = chip.dataset.token || '';
                    const start = input.selectionStart != null ? input.selectionStart : input.value.length;
                    const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
                    input.value = input.value.slice(0, start) + token + input.value.slice(end);
                    input.focus();
                    const caret = start + token.length;
                    input.setSelectionRange(caret, caret);
                    this._readParams(node, body);
                });
            });
            // If/Else rule field/op/value — delegated so it survives partial re-renders.
            this._bindIfElseRuleEvents(body, node);
        }

        _bindIfElseRuleEvents(body, node) {
            if (this._ruleChangeHandler && this._ruleChangeBody) {
                this._ruleChangeBody.removeEventListener('change', this._ruleChangeHandler);
            }
            this._ruleChangeBody = body;
            this._ruleChangeHandler = (e) => {
                const t = e.target;
                if (!t || !t.closest || !t.closest('#aeRules')) return;

                if (t.matches('select.ae-rule-field, select[data-rule="field"]')) {
                    const idx = parseInt(t.dataset.idx, 10);
                    this._readParams(node, body);
                    const rules = node.config.rules || (node.config.rules = []);
                    while (rules.length <= idx) {
                        rules.push({ field: '', op: 'eq', operator: 'eq', value: '' });
                    }
                    // Field changed → drop previous value so the right-side control rebuilds for the new type.
                    rules[idx].field = t.value || '';
                    rules[idx].value = '';
                    rules[idx].checklist_id = '';
                    rules[idx].id = '';
                    rules[idx].ids = [];
                    rules[idx].table = '';
                    rules[idx].column = '';
                    rules[idx].op = rules[idx].op || 'eq';
                    rules[idx].operator = rules[idx].op;
                    this._rerenderParams(node, true);
                    return;
                }

                if (t.matches('select[data-rule="lookup-table"]')) {
                    const idx = parseInt(t.dataset.idx, 10);
                    this._readParams(node, body);
                    const rules = node.config.rules || [];
                    if (rules[idx]) {
                        rules[idx].table = t.value || '';
                        rules[idx].column = '';
                        rules[idx].value = '';
                        rules[idx].checklist_id = '';
                        rules[idx].id = '';
                        rules[idx].ids = [];
                        rules[idx].filter_id = '';
                    }
                    this._rerenderParams(node, true);
                    return;
                }

                if (t.matches('select[data-rule="lookup-column"]')) {
                    const idx = parseInt(t.dataset.idx, 10);
                    this._readParams(node, body);
                    const rules = node.config.rules || [];
                    if (rules[idx]) {
                        rules[idx].column = t.value || '';
                        rules[idx].value = '';
                    }
                    this._rerenderParams(node, true);
                    return;
                }

                if (t.matches('select[data-rule="op"]')) {
                    const idx = parseInt(t.dataset.idx, 10);
                    this._readParams(node, body);
                    const rules = node.config.rules || [];
                    if (rules[idx]) {
                        rules[idx].op = t.value || 'eq';
                        rules[idx].operator = rules[idx].op;
                        if (rules[idx].op === 'empty' || rules[idx].op === 'not_empty') {
                            rules[idx].value = '';
                        }
                    }
                    this._rerenderParams(node, true);
                    return;
                }

                if (t.matches('select.ae-rule-value-preset')) {
                    const box = t.closest('.ae-rule-value-box');
                    if (!box) return;
                    const mode = t.value;
                    const pick = box.querySelector('.ae-rule-value-pick');
                    const custom = box.querySelector('.ae-rule-value-custom');
                    if (pick) pick.style.display = (mode === PICK_VALUE) ? 'block' : 'none';
                    if (custom) custom.style.display = (mode === CUSTOM_VALUE) ? 'block' : 'none';
                    // Re-init ajax picker when "Choose from list" becomes visible.
                    if (mode === PICK_VALUE && pick) {
                        pick.querySelectorAll('.n8n-select.ae-ajax-ss').forEach(el => {
                            delete el.dataset.ajaxBound;
                            this._initAjaxSingleSelect(el, () => this._readParams(node, body));
                        });
                    }
                    this._readParams(node, body);
                }
            };
            body.addEventListener('change', this._ruleChangeHandler);
        }

        _rerenderParams(node, skipRead) {
            const body = this.container.querySelector('#aeConfigBody');
            if (!body) return;
            if (!skipRead) this._readParams(node, body);
            const holder = body.querySelector('#aeParamsTab');
            if (!holder) return;
            holder.innerHTML = this._renderParams(node);
            this._initConfigWidgets(body, node);
        }

        _bindConditionalFields(body, node) {
            const toggleShow = (sel, show) => { const el = body.querySelector(sel); if (el) el.style.display = show ? '' : 'none'; };
            if (node.subtype === 'schedule') {
                const freq = () => this._getSelectVal(body, 'cfgFrequency') || node.config.frequency;
                const apply = () => {
                    const f = freq();
                    toggleShow('#cfgTimeWrap', f === 'daily');
                    toggleShow('#cfgCronWrap', f === 'cron');
                };
                const sel = body.querySelector('#cfgFrequency');
                if (sel) this._initSingleSelect(sel, () => { apply(); this._readParams(node, body); });
                apply();
            }
            if (node.subtype === 'notify') {
                const applyNotify = () => {
                    const channel = this._getSelectVal(body, 'cfgChannel') || node.config.channel || 'email';
                    const mode = this._getSelectVal(body, 'cfgContentMode') || node.config.content_mode || 'custom';
                    const recipientMode = this._getSelectVal(body, 'cfgRecipientMode') || node.config.recipient_mode || 'users';
                    const wantsEmail = channel === 'email' || channel === 'both';
                    const wantsPush = channel === 'push' || channel === 'both';
                    toggleShow('#cfgNotifyContentWrap', wantsEmail || wantsPush);
                    toggleShow('#cfgNotifyTemplateWrap', mode === 'template');
                    toggleShow('#cfgNotifyCustomWrap', mode === 'custom');
                    toggleShow('#cfgNotifyPushTemplateWrap', mode === 'template' && wantsPush);
                    toggleShow('#cfgNotifyAttachWrap', mode === 'custom' && wantsEmail);
                    toggleShow('#cfgNotifyRolesWrap', recipientMode === 'roles' || recipientMode === 'users');
                    toggleShow('#cfgNotifyUsersWrap', recipientMode === 'users');
                    // When push-only + template, still show template wrap with push template; hide email template field's requirement visually
                    const emailTplField = body.querySelector('#cfgEmailTemplate')?.closest('.n8n-config-field');
                    if (emailTplField) emailTplField.style.display = (mode === 'template' && wantsEmail) ? '' : 'none';
                };
                const channelSel = body.querySelector('#cfgChannel');
                const modeSel = body.querySelector('#cfgContentMode');
                const recipientSel = body.querySelector('#cfgRecipientMode');
                if (channelSel) this._initSingleSelect(channelSel, () => { applyNotify(); this._readParams(node, body); });
                if (modeSel) this._initSingleSelect(modeSel, () => { applyNotify(); this._readParams(node, body); });
                if (recipientSel) this._initSingleSelect(recipientSel, () => { applyNotify(); this._readParams(node, body); });
                applyNotify();
                this._bindNotifyAttachments(body, node);
                this._bindNotifyRoleUserFilter(body, node);
            }
        }

        _bindNotifyRoleUserFilter(body, node) {
            const rolesEl = body.querySelector('#cfgNotifyRoles');
            const usersEl = body.querySelector('#cfgNotifyUsers');
            if (!rolesEl || !usersEl) return;

            usersEl._aeGetExtra = () => {
                const roleIds = this._getMultiVal(body, 'cfgNotifyRoles');
                return { filter_by_roles: 1, roles: roleIds.join(',') };
            };

            const onRolesChanged = () => {
                this._readParams(node, body);
                if (typeof usersEl.aeReload === 'function') {
                    usersEl.aeReload(true);
                }
                this._readParams(node, body);
            };

            rolesEl._aeOnChange = onRolesChanged;
            usersEl._aeOnChange = () => this._readParams(node, body);
        }

        _bindNotifyAttachments(body, node) {
            if (!Array.isArray(node.config.attachments)) node.config.attachments = [];
            const input = body.querySelector('#cfgAttachInput');
            const btn = body.querySelector('#cfgAttachBtn');
            const list = body.querySelector('#cfgAttachList');
            if (!input || !btn || !list) return;

            const render = () => {
                const rows = node.config.attachments || [];
                if (!rows.length) {
                    list.innerHTML = '<div class="ae-help" style="margin:0">No attachments yet.</div>';
                    return;
                }
                list.innerHTML = rows.map((a, i) => {
                    const name = this._esc(a.name || a.path || ('File ' + (i + 1)));
                    return `<div class="ae-attach-row" data-idx="${i}">
                        <i class="bi bi-paperclip"></i>
                        <span class="ae-attach-name" title="${name}">${name}</span>
                        <button type="button" class="ae-attach-remove" data-idx="${i}" title="Remove">&times;</button>
                    </div>`;
                }).join('');
                list.querySelectorAll('.ae-attach-remove').forEach(b => {
                    b.addEventListener('click', (e) => {
                        e.preventDefault();
                        const idx = parseInt(b.getAttribute('data-idx'), 10);
                        if (!isNaN(idx)) {
                            node.config.attachments.splice(idx, 1);
                            render();
                            this._readParams(node, body);
                        }
                    });
                });
            };

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                input.click();
            });

            input.addEventListener('change', () => {
                const files = Array.from(input.files || []);
                input.value = '';
                if (!files.length) return;
                const url = this.data.uploadAttachmentUrl;
                if (!url) {
                    this._toast('Upload URL missing — reload the canvas.', 'error');
                    return;
                }
                files.forEach(file => {
                    const fd = new FormData();
                    fd.append('file', file);
                    fetch(url, {
                        method: 'POST',
                        headers: this._csrfHeaders(),
                        credentials: 'same-origin',
                        body: fd
                    }).then(r => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.json();
                    }).then(res => {
                        if (!res || !res.path) throw new Error('Bad response');
                        node.config.attachments.push({ path: res.path, name: res.name || file.name });
                        render();
                        this._readParams(node, body);
                    }).catch(err => {
                        this._toast('Attachment upload failed: ' + (err.message || 'error'), 'error');
                    });
                });
            });

            render();
        }

        // ─── Per-subtype Parameter Inspectors ────────────────────────────
        _renderParams(node) {
            const c = node.config || {};
            const rs = (id, items, val, opts) => this._renderSingleSelect(id, items, val, opts);
            const ms = (id, items, vals, ph) => this._renderMultiSelect(id, items, vals, ph);
            const toggle = (id, on, label) => `<div class="n8n-field-toggle"><span class="n8n-field-toggle-label">${this._esc(label)}</span><div class="n8n-toggle ae-toggle ${on ? 'active' : ''}" id="${id}"></div></div>`;
            const sec = (title, inner) => `<div class="n8n-config-section"><div class="n8n-config-section-title">${this._esc(title)}</div>${inner}</div>`;
            const field = (label, inner, req) => `<div class="n8n-config-field"><label class="n8n-config-label">${this._esc(label)}${req ? ' <span class="n8n-required">*</span>' : ''}</label>${inner}</div>`;

            switch (node.subtype) {
                case 'schedule':
                    return sec('Schedule', [
                        field('Frequency', rs('cfgFrequency', [
                            { value: 'daily', label: 'Daily' }, { value: 'hourly', label: 'Hourly' }, { value: 'cron', label: 'Custom (cron)' }
                        ], c.frequency || 'daily', { allowEmpty: false })),
                        `<div id="cfgTimeWrap">${field('Time', `<input type="time" class="ae-cfg-input" id="cfgTime" value="${this._esc(c.time || '09:00')}">`)}</div>`,
                        field('Timezone', rs('cfgTimezone', this.timezones, c.timezone, { allowEmpty: false, placeholder: 'Timezone' })),
                        `<div id="cfgCronWrap">${field('Cron expression', `<input type="text" class="ae-cfg-input" id="cfgCron" placeholder="*/5 * * * *" value="${this._esc(c.cron || '')}">`)}</div>`
                    ].join(''));

                case 'webhook':
                    const whUrl = this.data.webhookUrl || '';
                    return sec('Webhook', whUrl
                        ? `<div class="n8n-field"><label class="n8n-label">Inbound URL</label>
                             <input class="n8n-input" type="text" readonly value="${this._esc(whUrl)}">
                             <div class="ae-help" style="margin-top:8px"><i class="bi bi-shield-lock"></i> Send header <code>X-Automation-Signature</code> = HMAC-SHA256 of the raw body using the automation secret.</div>
                           </div>`
                        : `<div class="ae-help"><i class="bi bi-info-circle"></i> A unique webhook URL will be issued when this automation is <strong>published</strong>. POST events to that URL to trigger runs.</div>`);

                case 'record':
                    return this._renderRecordTriggerParams(c);

                case 'checklist.submitted':
                    return sec('Filters', [
                        field('Checklists', this._renderAjaxMultiSelect('cfgTrigChecklists', this.data.checklistListUrl, c.checklist_ids, 'Search checklists...')),
                        field('Submitted by (users)', this._renderAjaxMultiSelect('cfgTrigUsers', this.data.usersListUrl, c.user_ids, 'Search users...')),
                        field('Assets', this._renderAjaxMultiSelect('cfgTrigAssets', this.data.assetsListUrl, c.asset_ids, 'Search assets...', { assets: 1 })),
                        field('Locations', this._renderAjaxMultiSelect('cfgTrigLocations', this.data.storesListUrl || this.data.assetsListUrl, c.location_ids, 'Search locations...', { assetswloc: 1, type_filter: 'location' })),
                        `<div class="ae-help">Leave filters empty to run for every submission. Matching submissions start this automation.</div>`
                    ].join(''));
                case 'ticket':
                    return sec('When & filters', [
                        field('Run when ticket is', ms('cfgTrigEvents', TICKET_EVENT_OPTIONS, c.events && c.events.length ? c.events : ['created', 'updated', 'closed'], 'Select events...'), true),
                        field('Priorities', ms('cfgTrigPriorities', [
                            { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
                            { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }
                        ], c.priorities, 'Select priorities...')),
                        field('Assets', this._renderAjaxMultiSelect('cfgTrigAssets', this.data.assetsListUrl, c.asset_ids, 'Search assets...', { assets: 1 })),
                        field('Locations', this._renderAjaxMultiSelect('cfgTrigLocations', this.data.storesListUrl || this.data.assetsListUrl, c.location_ids, 'Search locations...', { assetswloc: 1, type_filter: 'location' })),
                        field('Departments', this._renderAjaxMultiSelect('cfgTrigDepartments', this.data.departmentsListUrl, c.department_ids, 'Search departments...')),
                        field('Particulars', this._renderAjaxMultiSelect('cfgTrigParticulars', this.data.particularsListUrl, c.particular_ids, 'Search particulars...')),
                        field('Issues', this._renderAjaxMultiSelect('cfgTrigIssues', this.data.issuesListUrl, c.issue_ids, 'Search issues...')),
                        `<div class="ae-help">Pick which ticket events start this run. Leave filters empty to match any.</div>`
                    ].join(''));
                case 'ticket.created':
                case 'ticket.updated':
                case 'ticket.closed':
                    return sec('Filters', [
                        field('Priorities', ms('cfgTrigPriorities', [
                            { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
                            { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }
                        ], c.priorities, 'Select priorities...')),
                        field('Assets', this._renderAjaxMultiSelect('cfgTrigAssets', this.data.assetsListUrl, c.asset_ids, 'Search assets...', { assets: 1 })),
                        field('Locations', this._renderAjaxMultiSelect('cfgTrigLocations', this.data.storesListUrl || this.data.assetsListUrl, c.location_ids, 'Search locations...', { assetswloc: 1, type_filter: 'location' })),
                        field('Departments', this._renderAjaxMultiSelect('cfgTrigDepartments', this.data.departmentsListUrl, c.department_ids, 'Search departments...')),
                        field('Particulars', this._renderAjaxMultiSelect('cfgTrigParticulars', this.data.particularsListUrl, c.particular_ids, 'Search particulars...')),
                        field('Issues', this._renderAjaxMultiSelect('cfgTrigIssues', this.data.issuesListUrl, c.issue_ids, 'Search issues...')),
                        `<div class="ae-help">Legacy trigger. Prefer the single <strong>Ticket</strong> trigger and set events in its properties.</div>`
                    ].join(''));
                case 'asset':
                    return sec('When & filters', [
                        field('Run when asset is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                        field('Only if these fields changed', ms('cfgTrigChangedFields', ASSET_CHANGE_FIELDS, c.changed_fields, 'Any field (leave empty)...')),
                        field('Assets', this._renderAjaxMultiSelect('cfgTrigAssets', this.data.assetsListUrl, c.asset_ids, 'Search assets...', { assets: 1 })),
                        `<div class="ae-help">Field filters apply on <strong>Updated</strong> only. Empty “fields changed” = any update. Example: watch Name or Asset status.</div>`
                    ].join(''));
                case 'asset.changed':
                    return sec('Filters', [
                        field('Assets', this._renderAjaxMultiSelect('cfgTrigAssets', this.data.assetsListUrl, c.asset_ids, 'Search assets...', { assets: 1 })),
                        `<div class="ae-help">Legacy trigger. Prefer the single <strong>Asset</strong> trigger.</div>`
                    ].join(''));
                case 'location':
                    return sec('When & filters', [
                        field('Run when location is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                        field('Only if these fields changed', ms('cfgTrigChangedFields', LOCATION_CHANGE_FIELDS, c.changed_fields, 'Any field (leave empty)...')),
                        field('Locations', this._renderAjaxMultiSelect('cfgTrigLocations', this.data.storesListUrl || this.data.assetsListUrl, c.location_ids, 'Search locations...', { assetswloc: 1, type_filter: 'location' })),
                        `<div class="ae-help">Example: select <strong>Opening time</strong> so the automation runs only when a location’s open time is updated. Field filters apply on updates, not creates.</div>`
                    ].join(''));
                case 'location.changed':
                    return sec('Filters', [
                        field('Locations', this._renderAjaxMultiSelect('cfgTrigLocations', this.data.storesListUrl || this.data.assetsListUrl, c.location_ids, 'Search locations...', { assetswloc: 1, type_filter: 'location' })),
                        `<div class="ae-help">Legacy trigger. Prefer the single <strong>Location</strong> trigger and set “Opening time” under fields changed.</div>`
                    ].join(''));
                case 'manual':
                    return sec('Trigger', `<div class="ae-help">This automation starts only when triggered manually.</div>`);

                case 'assign_checklist':
                    return sec('Assignment', [
                        field('Checklist', this._renderAjaxSingleSelect('cfgChecklist', this.data.checklistListUrl, c.checklist_id, '-- Select checklist --'), true),
                        field('Assignee mode', rs('cfgAssigneeMode', [
                            { value: 'roles', label: 'Roles' }, { value: 'users', label: 'Specific users' }, { value: 'asset_owners', label: 'Asset owners' }
                        ], c.assignee_mode || 'users', { allowEmpty: false })),
                        field('Assignment type', rs('cfgAssignmentType', [
                            { value: '1', label: 'Type 1 — Individual' }, { value: '2', label: 'Type 2 — Shared' }, { value: '3', label: 'Type 3 — Round-robin' }
                        ], c.assignment_type || '1', { allowEmpty: false })),
                        field('Roles', ms('cfgRoleIds', this.roles, c.role_ids, 'Search roles...')),
                        field('Users', this._renderAjaxMultiSelect('cfgUserIds', this.data.usersListUrl, c.user_ids, 'Search users...')),
                        field('Due (hours)', `<input type="number" min="0" class="ae-cfg-input" id="cfgDueHours" value="${c.due_hours != null ? c.due_hours : 24}">`)
                    ].join(''));

                case 'notify': {
                    const channel = c.channel || 'email';
                    const contentMode = c.content_mode || (c.email_template_id || c.template_id ? 'template' : 'custom');
                    const attachments = Array.isArray(c.attachments) ? c.attachments : [];
                    const attachRows = attachments.map((a, i) => {
                        const name = this._esc(a.name || a.path || ('File ' + (i + 1)));
                        return `<div class="ae-attach-row" data-idx="${i}">
                            <i class="bi bi-paperclip"></i>
                            <span class="ae-attach-name" title="${name}">${name}</span>
                            <button type="button" class="ae-attach-remove" data-idx="${i}" title="Remove">&times;</button>
                        </div>`;
                    }).join('');
                    return sec('Notification', [
                        field('Channel', rs('cfgChannel', [
                            { value: 'email', label: 'Email' }, { value: 'push', label: 'Push' }, { value: 'both', label: 'Email + Push' }
                        ], channel, { allowEmpty: false })),
                        field('Recipients', rs('cfgRecipientMode', [
                            { value: 'assignees', label: 'Task assignees' }, { value: 'users', label: 'Specific users' }, { value: 'roles', label: 'Roles' }
                        ], c.recipient_mode || 'users', { allowEmpty: false })),
                        `<div id="cfgNotifyRolesWrap">${field('Roles', ms('cfgNotifyRoles', this.roles, c.role_ids, 'Search roles...'))}</div>`,
                        `<div id="cfgNotifyUsersWrap">${field('Users', this._renderAjaxMultiSelect('cfgNotifyUsers', this.data.usersListUrl, c.user_ids, 'Select roles first, then users...', { filter_by_roles: 1, roles: (c.role_ids || []).join(',') }))}<div class="ae-help" style="margin-top:6px">Users list only includes people in the roles selected above.</div></div>`,
                        `<div id="cfgNotifyContentWrap">
                            ${field('Content source', rs('cfgContentMode', [
                                { value: 'template', label: 'Existing template' },
                                { value: 'custom', label: 'Custom title, body & attachments' }
                            ], contentMode, { allowEmpty: false }), true)}
                            <div id="cfgNotifyTemplateWrap">
                                ${field('Email template', this._renderAjaxSingleSelect('cfgEmailTemplate', this.data.notificationTemplateListUrl, c.email_template_id || c.template_id || '', 'Search email templates...', { type: 0, withType: 1 }), true)}
                                <div id="cfgNotifyPushTemplateWrap">${field('Push template', this._renderAjaxSingleSelect('cfgPushTemplate', this.data.notificationTemplateListUrl, c.push_template_id || '', 'Search push templates...', { type: 1, withType: 1 }))}</div>
                            </div>
                            <div id="cfgNotifyCustomWrap">
                                ${field('Title / subject', `<input type="text" class="ae-cfg-input" id="cfgSubject" value="${this._esc(c.subject || c.title || '')}">`, true)}
                                ${field('Body', `<textarea class="ae-cfg-input" id="cfgBody" rows="4">${this._esc(c.body || c.message || '')}</textarea>`)}
                                <div id="cfgNotifyAttachWrap">${field('Attachments', `
                                    <div class="ae-attach-box">
                                        <input type="file" id="cfgAttachInput" multiple style="display:none">
                                        <button type="button" class="n8n-modal-btn n8n-modal-btn-secondary" id="cfgAttachBtn"><i class="bi bi-upload"></i> Add files</button>
                                        <div class="ae-attach-list" id="cfgAttachList">${attachRows || '<div class="ae-help" style="margin:0">No attachments yet.</div>'}</div>
                                    </div>
                                `)}</div>
                            </div>
                            <div class="ae-help">Template mode uses Notification Templates. Custom mode lets you set title, body, and optional file attachments (email only).</div>
                        </div>`
                    ].join(''));
                }

                case 'create_ticket':
                    return sec('Ticket', [
                        field('Subject', `<input type="text" class="ae-cfg-input" id="cfgTkSubject" value="${this._esc(c.subject || '')}">`, true),
                        field('Description', `<textarea class="ae-cfg-input" id="cfgTkDesc" rows="3">${this._esc(c.description || '')}</textarea>`),
                        field('Priority', rs('cfgTkPriority', [
                            { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }
                        ], c.priority || 'medium', { allowEmpty: false })),
                        field('Owner', rs('cfgTkOwnerMode', [
                            { value: 'asset_owner', label: 'Asset owner' }, { value: 'reporter', label: 'Reporter' }, { value: 'unassigned', label: 'Unassigned' }
                        ], c.owner_mode || 'asset_owner', { allowEmpty: false }))
                    ].join(''));

                case 'if_else': {
                    const rules = (c.rules && c.rules.length) ? c.rules : [{ field: '', op: 'eq', value: '' }];
                    const catalog = this._conditionFieldCatalog();
                    const rows = rules.map((r, i) => this._renderConditionRuleRow(r, i, catalog)).join('');
                    return sec('Conditions', [
                        field('Match', rs('cfgLogic', [{ value: 'and', label: 'All (AND)' }, { value: 'or', label: 'Any (OR)' }], c.logic || 'and', { allowEmpty: false })),
                        `<div id="aeRules">${rows}</div>`,
                        `<button class="n8n-modal-btn n8n-modal-btn-secondary" id="aeAddRule" type="button" style="margin-top:4px;"><i class="bi bi-plus-lg"></i> Add rule</button>`,
                        `<div class="ae-help" style="margin-top:12px;">Fields come from your <strong>trigger</strong>, earlier <strong>steps</strong>, and <strong>Lookups</strong>. Use <strong>Table / column lookup</strong> to pick a table (e.g. Checklist tasks) then a column (e.g. Score %) and compare it (e.g. &gt; 80). Matching rules follow <strong>Yes</strong>; otherwise <strong>No</strong>.</div>`
                    ].join(''));
                }

                case 'wait':
                    return sec('Wait', [
                        field('Duration', `<div class="ae-inline">
                            <input type="number" min="0" class="ae-cfg-input" id="cfgDurValue" value="${c.duration_value != null ? c.duration_value : 1}">
                            ${rs('cfgDurUnit', [{ value: 'minutes', label: 'Minutes' }, { value: 'hours', label: 'Hours' }, { value: 'days', label: 'Days' }], c.duration_unit || 'hours', { allowEmpty: false })}
                        </div>`)
                    ].join(''));

                case 'wait_until':
                    return sec('Wait Until', [
                        field('Event', rs('cfgWuEvent', EVENT_OPTIONS, c.event || 'checklist.submitted', { allowEmpty: false })),
                        field('Timeout', `<div class="ae-inline">
                            <input type="number" min="0" class="ae-cfg-input" id="cfgWuTimeoutValue" value="${c.timeout_value != null ? c.timeout_value : 24}">
                            ${rs('cfgWuTimeoutUnit', [{ value: 'minutes', label: 'Minutes' }, { value: 'hours', label: 'Hours' }, { value: 'days', label: 'Days' }], c.timeout_unit || 'hours', { allowEmpty: false })}
                        </div>`),
                        `<div class="ae-help">If the event doesn't happen before the timeout, the <strong>Timeout</strong> branch runs (use this for overdue escalation).</div>`
                    ].join(''));

                case 'for_each':
                    return sec('For Each', [
                        field('Collection', rs('cfgCollection', [
                            { value: 'assigned_task_ids', label: 'Assigned checklist tasks' },
                            { value: 'assigned_user_ids', label: 'Assigned users' },
                            { value: 'assets', label: 'Assets (legacy)' },
                            { value: 'users', label: 'Users (legacy)' }
                        ], c.collection || 'assigned_task_ids', { allowEmpty: false })),
                        field('Filter', toggle('cfgVehiclesOnly', !!c.vehicles_only, 'Vehicles only')),
                        `<div class="ae-help">The <strong>Each</strong> branch runs once per item; <strong>After</strong> runs once the loop finishes.</div>`
                    ].join(''));

                case 'approval':
                    return sec('Approval', [
                        field('Approver mode', rs('cfgApproverMode', [
                            { value: 'users', label: 'Specific users' }, { value: 'roles', label: 'Roles' }
                        ], c.approver_mode || 'users', { allowEmpty: false })),
                        field('Users', this._renderAjaxMultiSelect('cfgApprUsers', this.data.usersListUrl, c.user_ids || c.approver_user_ids, 'Search users...')),
                        field('Roles', ms('cfgApprRoles', this.roles, c.role_ids || c.approver_role_ids, 'Search roles...')),
                        field('Message', `<textarea class="ae-cfg-input" id="cfgApprMsg" rows="3">${this._esc(c.message || '')}</textarea>`),
                        field('Timeout (hours)', `<input type="number" min="0" class="ae-cfg-input" id="cfgApprTimeout" value="${c.timeout != null ? c.timeout : (c.timeout_value != null ? c.timeout_value : 48)}">`)
                    ].join(''));

                case 'http_request':
                    return sec('HTTP Request', [
                        field('Method', rs('cfgHttpMethod', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => ({ value: m, label: m })), c.method || 'POST', { allowEmpty: false })),
                        field('URL', `<input type="text" class="ae-cfg-input" id="cfgHttpUrl" placeholder="https://api.example.com/hook" value="${this._esc(c.url || '')}">`, true),
                        field('Body (JSON)', `<textarea class="ae-cfg-input" id="cfgHttpBody" rows="4" placeholder='{ "key": "value" }'>${this._esc(c.body || '')}</textarea>`),
                        field('Timeout (seconds)', `<input type="number" min="1" class="ae-cfg-input" id="cfgHttpTimeout" value="${c.timeout_seconds != null ? c.timeout_seconds : 30}">`),
                        field('On error', toggle('cfgHttpFail', c.fail_on_error !== false, 'Fail the run on error'))
                    ].join(''));

                case 'dedupe':
                    return sec('Deduplicate', [
                        field('Key template', `<input type="text" class="ae-cfg-input" id="cfgDedupeKey" placeholder="Click tokens below or pick an asset" value="${this._esc(c.key_template || c.key || '')}">`, true),
                        `<div class="ae-token-row">${DEDUPE_TOKENS.map(t =>
                            `<button type="button" class="ae-token-chip" data-token="${this._esc(t.token)}">${this._esc(t.label)}</button>`
                        ).join('')}</div>`,
                        field('Or pick a specific asset', this._renderAjaxSingleSelect('cfgDedupeAsset', this.data.assetsListUrl, '', 'Search assets (scroll for more)...', { assets: 1 })),
                        field('TTL (seconds)', `<input type="number" min="0" class="ae-cfg-input" id="cfgDedupeTtl" value="${c.ttl_seconds != null ? c.ttl_seconds : 3600}">`),
                        field('Behaviour', toggle('cfgDedupeSkip', c.skip_silently !== false, 'Skip duplicates silently')),
                        `<div class="ae-help">Build a key from tokens (resolved at runtime from the event) and/or a specific asset you select by name. First occurrence follows <strong>Continue</strong>; repeats within the TTL follow <strong>Duplicate</strong>.</div>`
                    ].join(''));

                case 'parallel':
                    return sec('Parallel', `<div class="ae-help">Runs <strong>Branch 1</strong> and <strong>Branch 2</strong> at the same time. <strong>After</strong> runs once both complete.</div>`);
                case 'merge':
                    return sec('Merge', `<div class="ae-help">Joins multiple incoming branches into one before continuing.</div>`);
                case 'end':
                    return sec('End', `<div class="ae-help">Terminates this branch of the automation.</div>`);
                default:
                    return sec('Parameters', `<div class="ae-help">No parameters for this node.</div>`);
            }
        }

        // Commit current form values back into node.config.
        _readParams(node, body) {
            const c = node.config || (node.config = {});
            const num = (id, d) => { const el = body.querySelector('#' + id); const v = el ? parseInt(el.value, 10) : NaN; return Number.isNaN(v) ? d : v; };
            const txt = (id) => { const el = body.querySelector('#' + id); return el ? el.value : ''; };
            const sv = (id) => this._getSelectVal(body, id);
            const mv = (id) => this._getMultiVal(body, id);
            const tog = (id) => { const el = body.querySelector('#' + id); return el ? el.classList.contains('active') : false; };

            switch (node.subtype) {
                case 'schedule':
                    c.frequency = sv('cfgFrequency') || 'daily';
                    if (body.querySelector('#cfgTime')) {
                        c.time = txt('cfgTime');
                        c.time_of_day = c.time;
                    }
                    c.timezone = sv('cfgTimezone');
                    if (body.querySelector('#cfgCron')) {
                        c.cron = txt('cfgCron');
                        c.cron_expression = c.cron;
                    }
                    break;
                case 'record':
                    c.source = sv('cfgRecordSource');
                    c.events = mv('cfgTrigEvents');
                    c.actions = mv('cfgTrigActions');
                    c.changed_fields = mv('cfgTrigChangedFields');
                    c.priorities = mv('cfgTrigPriorities');
                    c.checklist_ids = mv('cfgTrigChecklists');
                    c.user_ids = mv('cfgTrigUsers');
                    c.store_ids = mv('cfgTrigStores');
                    c.asset_ids = mv('cfgTrigAssets');
                    c.location_ids = mv('cfgTrigLocations');
                    c.document_ids = mv('cfgTrigDocuments');
                    c.role_ids = mv('cfgTrigRoles');
                    c.task_ids = mv('cfgTrigTasks');
                    c.zone_ids = mv('cfgTrigZones');
                    c.department_ids = mv('cfgTrigDepartments');
                    c.particular_ids = mv('cfgTrigParticulars');
                    c.issue_ids = mv('cfgTrigIssues');
                    break;
                case 'checklist.submitted':
                    c.checklist_ids = mv('cfgTrigChecklists');
                    c.user_ids = mv('cfgTrigUsers');
                    c.store_ids = mv('cfgTrigStores');
                    c.asset_ids = mv('cfgTrigAssets');
                    c.location_ids = mv('cfgTrigLocations');
                    break;
                case 'ticket':
                    c.events = mv('cfgTrigEvents');
                    c.priorities = mv('cfgTrigPriorities');
                    c.store_ids = mv('cfgTrigStores');
                    c.asset_ids = mv('cfgTrigAssets');
                    c.location_ids = mv('cfgTrigLocations');
                    c.department_ids = mv('cfgTrigDepartments');
                    c.particular_ids = mv('cfgTrigParticulars');
                    c.issue_ids = mv('cfgTrigIssues');
                    break;
                case 'ticket.created':
                case 'ticket.updated':
                case 'ticket.closed':
                    c.priorities = mv('cfgTrigPriorities');
                    c.store_ids = mv('cfgTrigStores');
                    c.asset_ids = mv('cfgTrigAssets');
                    c.location_ids = mv('cfgTrigLocations');
                    c.department_ids = mv('cfgTrigDepartments');
                    c.particular_ids = mv('cfgTrigParticulars');
                    c.issue_ids = mv('cfgTrigIssues');
                    break;
                case 'asset':
                    c.actions = mv('cfgTrigActions');
                    c.changed_fields = mv('cfgTrigChangedFields');
                    c.asset_ids = mv('cfgTrigAssets');
                    break;
                case 'asset.changed':
                    c.asset_ids = mv('cfgTrigAssets');
                    break;
                case 'location':
                    c.actions = mv('cfgTrigActions');
                    c.changed_fields = mv('cfgTrigChangedFields');
                    c.location_ids = mv('cfgTrigLocations');
                    break;
                case 'location.changed':
                    c.location_ids = mv('cfgTrigLocations');
                    break;
                case 'assign_checklist':
                    c.checklist_id = sv('cfgChecklist');
                    c.assignee_mode = sv('cfgAssigneeMode');
                    c.assignment_type = sv('cfgAssignmentType');
                    c.role_ids = mv('cfgRoleIds');
                    c.user_ids = mv('cfgUserIds');
                    c.due_hours = num('cfgDueHours', 0);
                    break;
                case 'notify':
                    c.channel = sv('cfgChannel');
                    c.recipient_mode = sv('cfgRecipientMode');
                    c.user_ids = mv('cfgNotifyUsers');
                    c.role_ids = mv('cfgNotifyRoles');
                    c.content_mode = sv('cfgContentMode') || c.content_mode || 'custom';
                    c.email_template_id = sv('cfgEmailTemplate') || '';
                    c.push_template_id = sv('cfgPushTemplate') || '';
                    c.template_id = c.email_template_id || c.template_id || '';
                    if (body.querySelector('#cfgSubject')) {
                        c.subject = txt('cfgSubject');
                        c.body = txt('cfgBody');
                        c.title = c.subject;
                        c.message = c.body;
                    }
                    if (!Array.isArray(c.attachments)) c.attachments = [];
                    break;
                case 'create_ticket':
                    c.subject = txt('cfgTkSubject');
                    c.description = txt('cfgTkDesc');
                    c.priority = sv('cfgTkPriority');
                    c.owner_mode = sv('cfgTkOwnerMode');
                    break;
                case 'if_else':
                    c.logic = sv('cfgLogic');
                    c.match = (c.logic === 'or') ? 'any' : 'all';
                    c.rules = this._readRules(body);
                    break;
                case 'wait':
                    c.duration_value = num('cfgDurValue', 0);
                    c.duration_unit = sv('cfgDurUnit');
                    c.value = c.duration_value;
                    c.unit = c.duration_unit;
                    break;
                case 'wait_until':
                    c.event = sv('cfgWuEvent');
                    c.timeout_value = num('cfgWuTimeoutValue', 0);
                    c.timeout_unit = sv('cfgWuTimeoutUnit');
                    break;
                case 'for_each':
                    c.collection = sv('cfgCollection');
                    c.vehicles_only = tog('cfgVehiclesOnly');
                    if (c.collection === 'assigned_task_ids' || c.collection === 'assigned_user_ids') {
                        c.items_path = c.collection;
                    } else if (c.collection === 'users') {
                        c.items_path = 'assigned_user_ids';
                    } else {
                        c.items_path = 'assigned_task_ids';
                    }
                    break;
                case 'approval':
                    c.approver_mode = sv('cfgApproverMode');
                    c.user_ids = mv('cfgApprUsers');
                    c.role_ids = mv('cfgApprRoles');
                    c.approver_user_ids = c.user_ids;
                    c.approver_role_ids = c.role_ids;
                    c.message = txt('cfgApprMsg');
                    c.timeout = num('cfgApprTimeout', 0);
                    c.timeout_value = c.timeout;
                    c.timeout_unit = 'hours';
                    break;
                case 'http_request':
                    c.method = sv('cfgHttpMethod');
                    c.url = txt('cfgHttpUrl');
                    c.body = txt('cfgHttpBody');
                    c.timeout_seconds = num('cfgHttpTimeout', 30);
                    c.fail_on_error = tog('cfgHttpFail');
                    break;
                case 'dedupe':
                    c.key_template = txt('cfgDedupeKey');
                    c.key = c.key_template;
                    c.ttl_seconds = num('cfgDedupeTtl', 0);
                    c.skip_silently = tog('cfgDedupeSkip');
                    break;
                default: break;
            }
        }

        _readRules(body) {
            const rows = {};
            body.querySelectorAll('#aeRules .ae-rule-card').forEach(row => {
                const idx = row.dataset.idx;
                if (idx == null) return;
                const entry = { field: '', op: 'eq', operator: 'eq', value: '', table: '', column: '', checklist_id: '', id: '', ids: [] };
                const fieldSel = row.querySelector('[data-rule="field"]');
                const opSel = row.querySelector('[data-rule="op"]');
                if (fieldSel) entry.field = fieldSel.value || '';
                if (opSel) {
                    entry.op = opSel.value || 'eq';
                    entry.operator = entry.op;
                }

                const tableSel = row.querySelector('[data-rule="lookup-table"]');
                const columnSel = row.querySelector('[data-rule="lookup-column"]');
                if (tableSel) entry.table = tableSel.value || '';
                if (columnSel) entry.column = columnSel.value || '';

                // Optional filters (e.g. checklist_id, users / locations ids).
                row.querySelectorAll('[id^="cfgRuleFilter_"]').forEach(el => {
                    const id = el.id || '';
                    // cfgRuleFilter_{key}_{idx}
                    const m = id.match(/^cfgRuleFilter_(.+)_\d+$/);
                    if (!m) return;
                    const key = m[1];
                    if (el.classList.contains('n8n-multiselect')) {
                        const vals = this._getMultiVal(row, id).map(String).filter(Boolean);
                        entry[key] = vals;
                        if (key === 'ids') {
                            entry.ids = vals;
                            entry.id = vals[0] || '';
                        }
                        return;
                    }
                    const val = this._getSelectVal(row, id) || '';
                    entry[key] = val;
                    if (key === 'checklist_id' || key === 'id') {
                        entry.checklist_id = entry.checklist_id || val;
                        if (key === 'id' && !entry.ids.length && val) {
                            entry.ids = [String(val)];
                            entry.id = String(val);
                        }
                    }
                });
                row.querySelectorAll('[data-rule="lookup-filter"]').forEach(inp => {
                    const key = inp.getAttribute('data-filter-key');
                    if (!key) return;
                    entry[key] = inp.value || '';
                });

                // Legacy single checklist picker id (older UI).
                const legacyChecklist = row.querySelector('#cfgRuleChecklist' + idx);
                if (legacyChecklist && !entry.checklist_id) {
                    entry.checklist_id = this._getSelectVal(row, legacyChecklist.id) || '';
                }

                if (entry.field === 'lookup.checklist_task_percentage') {
                    entry.field = LOOKUP_FIELD_PATH;
                    entry.table = entry.table || 'checklist_tasks';
                    entry.column = entry.column || 'percentage';
                }

                if (entry.op === 'empty' || entry.op === 'not_empty') {
                    entry.value = '';
                    rows[idx] = entry;
                    return;
                }

                const preset = row.querySelector('[data-rule="value-preset"]');
                if (preset) {
                    const mode = preset.value || '';
                    if (!mode) {
                        entry.value = '';
                    } else if (mode === CUSTOM_VALUE) {
                        const custom = row.querySelector('[data-rule="value-custom"]');
                        entry.value = custom ? (custom.value || '') : '';
                    } else if (mode === PICK_VALUE) {
                        const wrap = row.querySelector('.ae-rule-value-wrap');
                        const ajax = wrap ? wrap.querySelector('.n8n-select') : null;
                        entry.value = ajax ? (this._getSelectVal(wrap, ajax.id) || '') : '';
                    } else {
                        entry.value = mode;
                    }
                } else {
                    // Legacy fallback
                    const wrap = row.querySelector('.ae-rule-value-wrap');
                    const valueEl = row.querySelector('[data-rule="value"]');
                    if (wrap) {
                        const ajax = wrap.querySelector('.n8n-select');
                        entry.value = ajax ? (this._getSelectVal(wrap, ajax.id) || '') : '';
                    } else if (valueEl) {
                        entry.value = valueEl.value || '';
                    }
                }

                rows[idx] = entry;
            });
            const out = Object.keys(rows).sort((a, b) => Number(a) - Number(b)).map(k => rows[k]);
            return out.length ? out : [{ field: '', op: 'eq', operator: 'eq', value: '' }];
        }

        _renderRecordTriggerParams(c) {
            const sec = (title, inner) => `<div class="n8n-config-section"><div class="n8n-config-section-title">${this._esc(title)}</div>${inner}</div>`;
            const field = (label, inner, req) => `<div class="n8n-config-field"><label class="n8n-config-label">${this._esc(label)}${req ? ' <span class="n8n-required">*</span>' : ''}</label>${inner}</div>`;
            const rs = (id, items, val, opts) => this._renderSingleSelect(id, items, val, opts);
            const ms = (id, items, vals, ph) => this._renderMultiSelect(id, items, vals, ph);
            const source = c.source || '';

            const parts = [
                field('Source', rs('cfgRecordSource', RECORD_SOURCES, source, { placeholder: '-- Select source --' }), true)
            ];

            if (!source) {
                parts.push(`<div class="ae-help">Choose what this automation listens to first (location, ticket, checklist, …). More options appear after you pick a source.</div>`);
                return sec('Record event', parts.join(''));
            }

            if (source === 'ticket') {
                parts.push(
                    field('Run when ticket is', ms('cfgTrigEvents', TICKET_EVENT_OPTIONS, c.events && c.events.length ? c.events : ['created', 'updated', 'closed'], 'Select events...'), true),
                    field('Priorities', ms('cfgTrigPriorities', [
                        { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
                        { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }
                    ], c.priorities, 'Any priority...')),
                    field('Assets', this._renderAjaxMultiSelect('cfgTrigAssets', this.data.assetsListUrl, c.asset_ids, 'Search assets...', { assets: 1 })),
                    field('Locations', this._renderAjaxMultiSelect('cfgTrigLocations', this.data.storesListUrl || this.data.assetsListUrl, c.location_ids, 'Search locations...', { assetswloc: 1, type_filter: 'location' })),
                    field('Departments', this._renderAjaxMultiSelect('cfgTrigDepartments', this.data.departmentsListUrl, c.department_ids, 'Search departments...')),
                    field('Particulars', this._renderAjaxMultiSelect('cfgTrigParticulars', this.data.particularsListUrl, c.particular_ids, 'Search particulars...')),
                    field('Issues', this._renderAjaxMultiSelect('cfgTrigIssues', this.data.issuesListUrl, c.issue_ids, 'Search issues...'))
                );
            } else if (source === 'checklist') {
                const checklistEvents = (c.events || []).filter(e => e === 'created' || e === 'updated');
                parts.push(
                    field('Run when', ms('cfgTrigEvents', [
                        { value: 'created', label: 'Created' },
                        { value: 'updated', label: 'Updated' }
                    ], checklistEvents.length ? checklistEvents : ['created', 'updated'], 'Select events...'), true),
                    field('Checklists', this._renderAjaxMultiSelect('cfgTrigChecklists', this.data.checklistListUrl, c.checklist_ids, 'Search checklists...')),
                    field('Users', this._renderAjaxMultiSelect('cfgTrigUsers', this.data.usersListUrl, c.user_ids, 'Search users...'))
                );
            } else if (source === 'location') {
                parts.push(
                    field('Run when location is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                    field('Only if these fields changed', ms('cfgTrigChangedFields', LOCATION_CHANGE_FIELDS, c.changed_fields, 'Any field...')),
                    field('Locations', this._renderAjaxMultiSelect('cfgTrigLocations', this.data.storesListUrl || this.data.assetsListUrl, c.location_ids, 'Search locations...', { assetswloc: 1, type_filter: 'location' }))
                );
            } else if (source === 'asset') {
                parts.push(
                    field('Run when asset is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                    field('Only if these fields changed', ms('cfgTrigChangedFields', ASSET_CHANGE_FIELDS, c.changed_fields, 'Any field...')),
                    field('Assets', this._renderAjaxMultiSelect('cfgTrigAssets', this.data.assetsListUrl, c.asset_ids, 'Search assets...', { assets: 1 }))
                );
            } else if (source === 'document') {
                parts.push(
                    field('Run when document is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                    field('Documents', this._renderAjaxMultiSelect('cfgTrigDocuments', this.data.documentsListUrl, c.document_ids, 'Search documents...'))
                );
            } else if (source === 'user') {
                parts.push(
                    field('Run when user is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                    field('Users', this._renderAjaxMultiSelect('cfgTrigUsers', this.data.usersListUrl, c.user_ids, 'Search users...'))
                );
            } else if (source === 'role') {
                parts.push(
                    field('Run when role is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                    field('Roles', ms('cfgTrigRoles', this.roles, c.role_ids, 'Search roles...'))
                );
            } else if (source === 'task') {
                const taskActions = (c.actions || []).filter(a => a === 'updated' || a === 'in_progress' || a === 'submitted');
                parts.push(
                    field('Run when', ms('cfgTrigActions', [
                        { value: 'updated', label: 'Updated' },
                        { value: 'in_progress', label: 'On in progress' },
                        { value: 'submitted', label: 'On submitted' }
                    ], taskActions.length ? taskActions : ['updated', 'in_progress', 'submitted'], 'Select events...'), true),
                    field('Tasks', this._renderAjaxMultiSelect('cfgTrigTasks', this.data.tasksListUrl, c.task_ids, 'Search tasks...'))
                );
            } else if (source === 'zone') {
                parts.push(
                    field('Run when zone is', ms('cfgTrigActions', ENTITY_ACTION_OPTIONS, c.actions && c.actions.length ? c.actions : ['created', 'updated'], 'Select...'), true),
                    field('Zones', this._renderAjaxMultiSelect('cfgTrigZones', this.data.zonesListUrl, c.zone_ids, 'Search zones...'))
                );
            }

            parts.push(`<div class="ae-help">Source = what record. Then choose when it runs and optional filters. Checklist: created / updated. Task: updated / on in progress / on submitted. Example: Source <strong>Location</strong> + fields changed <strong>Opening time</strong>.</div>`);
            return sec('Record event', parts.join(''));
        }

        _conditionFieldCatalog() {
            const groups = [];
            const trigger = this.nodes.find(n => n.type === 'trigger');
            if (trigger) {
                let fields = TRIGGER_FIELD_MAP[trigger.subtype] || [];
                if (trigger.subtype === 'record') {
                    const src = (trigger.config && trigger.config.source) || '';
                    fields = TRIGGER_FIELD_MAP[src] || [
                        { path: 'trigger.source', label: 'Source', valueType: 'text' },
                        { path: 'trigger.action', label: 'Action / event', valueType: 'text' },
                        { path: 'trigger.id', label: 'Record ID', valueType: 'text' }
                    ];
                }
                if (fields.length) {
                    const srcLabel = trigger.subtype === 'record' && trigger.config && trigger.config.source
                        ? (' — ' + (RECORD_SOURCES.find(s => s.value === trigger.config.source)?.label || trigger.config.source))
                        : '';
                    groups.push({
                        label: 'From trigger — ' + (humanLabel(trigger.subtype) || trigger.subtype) + srcLabel,
                        options: fields.map(f => ({
                            value: f.path,
                            label: f.label,
                            valueType: f.valueType || 'text'
                        }))
                    });
                }
            }

            this.nodes.forEach(n => {
                if (n.type === 'trigger') return;
                const outs = NODE_OUTPUT_FIELDS[n.subtype];
                if (!outs || !outs.length) return;
                groups.push({
                    label: 'From step — ' + (n.name || humanLabel(n.subtype)),
                    options: outs.map(f => ({
                        value: String(n.id) + '.' + f.suffix,
                        label: f.label,
                        valueType: f.valueType || 'text'
                    }))
                });
            });

            groups.push({
                label: 'Run info',
                options: [
                    { value: 'trigger_type', label: 'How this run started', valueType: 'trigger_type' }
                ]
            });

            groups.push({
                label: 'Lookups (live data)',
                options: LOOKUP_CONDITION_FIELDS.map(f => ({
                    value: f.path,
                    label: f.label,
                    valueType: f.valueType || 'text'
                }))
            });

            return groups;
        }

        _findConditionFieldMeta(path, catalog) {
            for (let g = 0; g < (catalog || []).length; g++) {
                const hit = (catalog[g].options || []).find(o => String(o.value) === String(path));
                if (hit) return hit;
            }
            return { value: path, label: path, valueType: 'text' };
        }

        _conditionValuePresets(valueType) {
            if (CONDITION_VALUE_TYPES[valueType]) {
                return CONDITION_VALUE_TYPES[valueType].slice();
            }
            if (valueType === 'checklist' || valueType === 'user' || valueType === 'asset' || valueType === 'store'
                || valueType === 'task' || valueType === 'scheduling') {
                return [{ value: PICK_VALUE, label: 'Choose from list…' }];
            }
            return [];
        }

        _normalizeLookupRule(rule) {
            const r = Object.assign({}, rule || {});
            // Migrate older static "Checklist task score %" rules.
            if (r.field === 'lookup.checklist_task_percentage') {
                r.field = LOOKUP_FIELD_PATH;
                r.table = r.table || 'checklist_tasks';
                r.column = r.column || 'percentage';
            }
            return r;
        }

        _lookupTableMeta(table) {
            return LOOKUP_TABLES.find(t => t.value === table) || null;
        }

        _lookupColumnMeta(table, column) {
            const t = this._lookupTableMeta(table);
            if (!t) return null;
            return (t.columns || []).find(c => c.value === column) || null;
        }

        _isEntityValueType(vt) {
            return vt === 'checklist' || vt === 'user' || vt === 'asset' || vt === 'store'
                || vt === 'task' || vt === 'scheduling';
        }

        _renderEntityValuePicker(idx, vt, value) {
            const id = 'cfgRuleVal' + idx;
            if (vt === 'checklist' && this.data.checklistListUrl) {
                return this._renderAjaxSingleSelect(id + 'Sel', this.data.checklistListUrl, value, 'Select checklist...');
            }
            if (vt === 'user' && this.data.usersListUrl) {
                return this._renderAjaxSingleSelect(id + 'Sel', this.data.usersListUrl, value, 'Select user...');
            }
            if (vt === 'task' && this.data.tasksListUrl) {
                return this._renderAjaxSingleSelect(id + 'Sel', this.data.tasksListUrl, value, 'Select assigned task...');
            }
            if (vt === 'scheduling' && this.data.schedulingsListUrl) {
                return this._renderAjaxSingleSelect(id + 'Sel', this.data.schedulingsListUrl, value, 'Select checklist schedule...');
            }
            if ((vt === 'asset' || vt === 'store') && (this.data.assetsListUrl || this.data.storesListUrl)) {
                const url = vt === 'store'
                    ? (this.data.storesListUrl || this.data.assetsListUrl)
                    : (this.data.assetsListUrl || this.data.storesListUrl);
                const extra = vt === 'asset' ? { assets: 1 } : {};
                return this._renderAjaxSingleSelect(id + 'Sel', url, value, 'Select...', extra);
            }
            return `<input type="text" class="ae-cfg-input ae-rule-value-custom-input" data-rule="value-custom" data-idx="${idx}" placeholder="Enter ID" value="${this._esc(value || '')}">`;
        }

        _renderConditionFieldSelect(idx, selected, catalog) {
            const groups = (catalog || []).map(g => {
                const opts = (g.options || []).map(o =>
                    `<option value="${this._esc(o.value)}" ${String(o.value) === String(selected) ? 'selected' : ''}>${this._esc(o.label)}</option>`
                ).join('');
                return `<optgroup label="${this._esc(g.label)}">${opts}</optgroup>`;
            }).join('');
            const unknown = selected && !(catalog || []).some(g => (g.options || []).some(o => String(o.value) === String(selected)))
                ? `<option value="${this._esc(selected)}" selected>${this._esc(selected)}</option>`
                : '';
            return `<select class="ae-cfg-input ae-rule-field" data-rule="field" data-idx="${idx}">
                <option value="">-- Select field --</option>
                ${unknown}${groups}
            </select>`;
        }

        _renderConditionValueInput(idx, fieldPath, op, value, catalog, rule) {
            if (op === 'empty' || op === 'not_empty') {
                return `<input type="hidden" data-rule="value" data-idx="${idx}" value="">`;
            }

            const r = this._normalizeLookupRule(rule || {});
            let vt = 'text';
            if (fieldPath === LOOKUP_FIELD_PATH || fieldPath === 'lookup.checklist_task_percentage') {
                const col = this._lookupColumnMeta(r.table, r.column);
                vt = (col && col.valueType) || 'text';
            } else {
                const meta = this._findConditionFieldMeta(fieldPath, catalog);
                vt = meta.valueType || 'text';
            }

            const presets = this._conditionValuePresets(vt);
            const raw = value == null ? '' : String(value);
            const isEntity = this._isEntityValueType(vt);
            const presetMatch = presets.find(p => String(p.value) === raw && p.value !== PICK_VALUE && p.value !== CUSTOM_VALUE);

            let mode = '';
            if (!raw) {
                if (isEntity) mode = PICK_VALUE;
                else if (presets.length === 0) mode = CUSTOM_VALUE;
                else mode = '';
            } else if (presetMatch) {
                mode = raw;
            } else if (isEntity) {
                mode = PICK_VALUE;
            } else {
                mode = CUSTOM_VALUE;
            }

            const presetOpts = presets.map(o =>
                `<option value="${this._esc(o.value)}" ${mode === String(o.value) ? 'selected' : ''}>${this._esc(o.label)}</option>`
            ).join('');

            const showPick = mode === PICK_VALUE;
            const showCustom = mode === CUSTOM_VALUE;
            const customText = (showCustom || (!isEntity && mode === CUSTOM_VALUE)) ? raw : '';
            const pickValue = showPick ? raw : '';

            let secondary = '';
            if (isEntity) {
                secondary = `
                    <div class="ae-rule-value-extra ae-rule-value-pick" style="display:${showPick ? 'block' : 'none'};">
                        <div class="ae-rule-value-wrap" data-idx="${idx}">${this._renderEntityValuePicker(idx, vt, pickValue)}</div>
                    </div>
                    <div class="ae-rule-value-extra ae-rule-value-custom" style="display:${showCustom ? 'block' : 'none'};">
                        <input type="text" class="ae-cfg-input ae-rule-value-custom-input" data-rule="value-custom" data-idx="${idx}" placeholder="Enter ID or value" value="${this._esc(showCustom ? raw : '')}">
                    </div>`;
            } else {
                const inputType = (vt === 'percent' || vt === 'count' || vt === 'http_status') ? 'number' : 'text';
                secondary = `
                    <div class="ae-rule-value-extra ae-rule-value-custom" style="display:${showCustom ? 'block' : 'none'};">
                        <input type="${inputType}" class="ae-cfg-input ae-rule-value-custom-input" data-rule="value-custom" data-idx="${idx}" placeholder="Type a custom value" value="${this._esc(customText)}">
                    </div>`;
            }

            return `<div class="ae-rule-value-box" data-idx="${idx}" data-value-type="${this._esc(vt)}">
                <select class="ae-cfg-input ae-rule-value-preset" data-rule="value-preset" data-idx="${idx}">
                    <option value="">-- Select value --</option>
                    ${presetOpts}
                    <option value="${CUSTOM_VALUE}" ${mode === CUSTOM_VALUE ? 'selected' : ''}>Custom…</option>
                </select>
                ${secondary}
            </div>`;
        }

        _renderLookupTableSelect(idx, selected) {
            const opts = LOOKUP_TABLES.map(t =>
                `<option value="${this._esc(t.value)}" ${String(t.value) === String(selected) ? 'selected' : ''}>${this._esc(t.label)}</option>`
            ).join('');
            return `<select class="ae-cfg-input" data-rule="lookup-table" data-idx="${idx}">
                <option value="">-- Select table --</option>${opts}
            </select>`;
        }

        _renderLookupColumnSelect(idx, table, selected) {
            const meta = this._lookupTableMeta(table);
            const cols = (meta && meta.columns) ? meta.columns : [];
            const opts = cols.map(c =>
                `<option value="${this._esc(c.value)}" ${String(c.value) === String(selected) ? 'selected' : ''}>${this._esc(c.label)}</option>`
            ).join('');
            return `<select class="ae-cfg-input" data-rule="lookup-column" data-idx="${idx}" ${cols.length ? '' : 'disabled'}>
                <option value="">-- Select column --</option>${opts}
            </select>`;
        }

        _lookupFilterSelectedIds(rule, filterKey) {
            const r = rule || {};
            let raw = r[filterKey];
            if ((raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) && filterKey === 'ids') {
                raw = r.ids != null && r.ids !== '' ? r.ids : r.id;
            }
            if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
            if (raw == null || raw === '') return [];
            return [String(raw)];
        }

        _renderLookupFilters(idx, rule) {
            const r = this._normalizeLookupRule(rule || {});
            const meta = this._lookupTableMeta(r.table);
            if (!meta || !(meta.filters || []).length) return '';
            return (meta.filters || []).map(f => {
                let control = '';
                const multi = !!f.multiple;
                if (f.valueType === 'checklist') {
                    const val = r[f.key] || r.checklist_id || '';
                    control = this._renderAjaxSingleSelect('cfgRuleFilter_' + f.key + '_' + idx, this.data.checklistListUrl, val, 'Select checklist...');
                } else if (f.valueType === 'user') {
                    const vals = this._lookupFilterSelectedIds(r, f.key);
                    control = multi
                        ? this._renderAjaxMultiSelect('cfgRuleFilter_' + f.key + '_' + idx, this.data.usersListUrl, vals, 'Select users...')
                        : this._renderAjaxSingleSelect('cfgRuleFilter_' + f.key + '_' + idx, this.data.usersListUrl, vals[0] || '', 'Select user...');
                } else if (f.valueType === 'asset') {
                    const vals = this._lookupFilterSelectedIds(r, f.key);
                    const url = this.data.assetsListUrl || this.data.storesListUrl;
                    control = multi
                        ? this._renderAjaxMultiSelect('cfgRuleFilter_' + f.key + '_' + idx, url, vals, 'Select locations / assets...', { assets: 1 })
                        : this._renderAjaxSingleSelect('cfgRuleFilter_' + f.key + '_' + idx, url, vals[0] || '', 'Select location / asset...', { assets: 1 });
                } else {
                    control = `<input type="text" class="ae-cfg-input" data-rule="lookup-filter" data-filter-key="${this._esc(f.key)}" data-idx="${idx}" value="${this._esc(r[f.key] || '')}">`;
                }
                return `<div class="ae-rule-field">
                    <label class="ae-rule-label">${this._esc(f.label)}</label>
                    <div class="ae-rule-control">${control}</div>
                </div>`;
            }).join('');
        }

        _renderConditionRuleRow(rule, idx, catalog) {
            const r = this._normalizeLookupRule(rule || {});
            const op = r.op || r.operator || 'eq';
            const opOptions = [
                ['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'],
                ['gte', '≥'], ['lte', '≤'], ['contains', 'contains'],
                ['empty', 'is empty'], ['not_empty', 'is not empty']
            ].map(([v, lab]) =>
                `<option value="${v}" ${op === v ? 'selected' : ''}>${lab}</option>`
            ).join('');

            const isLookup = r.field === LOOKUP_FIELD_PATH || r.field === 'lookup.checklist_task_percentage';
            if (isLookup) {
                const filters = this._renderLookupFilters(idx, r);
                const valueReady = !!(r.table && r.column);
                return `<div class="ae-rule-card" data-idx="${idx}">
                    <div class="ae-rule-card-head">
                        <div class="ae-rule-field">
                            <label class="ae-rule-label">Source</label>
                            <div class="ae-rule-control">${this._renderConditionFieldSelect(idx, LOOKUP_FIELD_PATH, catalog)}</div>
                        </div>
                        <button class="ae-icon-btn ae-del-rule" data-idx="${idx}" title="Remove" type="button"><i class="bi bi-x"></i></button>
                    </div>
                    <div class="ae-rule-field">
                        <label class="ae-rule-label">Table</label>
                        <div class="ae-rule-control">${this._renderLookupTableSelect(idx, r.table || '')}</div>
                    </div>
                    <div class="ae-rule-field">
                        <label class="ae-rule-label">Column</label>
                        <div class="ae-rule-control">${this._renderLookupColumnSelect(idx, r.table || '', r.column || '')}</div>
                    </div>
                    ${filters || ''}
                    <div class="ae-rule-field">
                        <label class="ae-rule-label">Operator</label>
                        <div class="ae-rule-control"><select class="ae-cfg-input" data-rule="op" data-idx="${idx}">${opOptions}</select></div>
                    </div>
                    <div class="ae-rule-field">
                        <label class="ae-rule-label">Value</label>
                        <div class="ae-rule-control ae-rule-value-slot">${valueReady
                            ? this._renderConditionValueInput(idx, LOOKUP_FIELD_PATH, op, r.value, catalog, r)
                            : `<div class="ae-rule-hint">Select a table and column first</div>`}</div>
                    </div>
                </div>`;
            }

            return `<div class="ae-rule-card" data-idx="${idx}">
                <div class="ae-rule-card-head">
                    <div class="ae-rule-field">
                        <label class="ae-rule-label">Field</label>
                        <div class="ae-rule-control">${this._renderConditionFieldSelect(idx, r.field || '', catalog)}</div>
                    </div>
                    <button class="ae-icon-btn ae-del-rule" data-idx="${idx}" title="Remove" type="button"><i class="bi bi-x"></i></button>
                </div>
                <div class="ae-rule-field">
                    <label class="ae-rule-label">Operator</label>
                    <div class="ae-rule-control"><select class="ae-cfg-input" data-rule="op" data-idx="${idx}">${opOptions}</select></div>
                </div>
                <div class="ae-rule-field">
                    <label class="ae-rule-label">Value</label>
                    <div class="ae-rule-control ae-rule-value-slot">${this._renderConditionValueInput(idx, r.field || '', op, r.value, catalog, r)}</div>
                </div>
            </div>`;
        }

        // ─── Node selection / delete / duplicate ─────────────────────────
        _selectNode(node) {
            this._deselectAll();
            if (node.el) node.el.classList.add('selected');
            this.selectedNodes = [node];
        }

        _deselectAll() {
            this.nodesLayer.querySelectorAll('.n8n-node.selected').forEach(el => el.classList.remove('selected'));
            this.svg.querySelectorAll('.n8n-connection.selected').forEach(el => el.classList.remove('selected'));
            this.selectedNodes = [];
            this.selectedEdge = null;
        }

        _deleteNodeConfirm(node) {
            this._confirmDialog({
                title: 'Delete Node',
                message: `Delete <strong>${this._esc(node.name || 'this node')}</strong> and its connections? This can't be undone.`,
                confirmText: 'Delete',
                danger: true,
                onConfirm: () => this._deleteNode(node)
            });
        }

        _deleteNode(node) {
            const idx = this.nodes.indexOf(node);
            if (idx > -1) this.nodes.splice(idx, 1);
            this.edges = this.edges.filter(e => e.source !== node.id && e.target !== node.id);
            this.selectedNodes = [];
            this._renderNodes();
            this._renderConnections();
            this._bindNodeEvents();
            this._updateMinimap();
            if (this.configNode === node) this._closeConfig();
        }

        _deleteSelectedEdge() {
            if (!this.selectedEdge) return;
            this.edges = this.edges.filter(e => e !== this.selectedEdge);
            this.selectedEdge = null;
            this._renderConnections();
            this._updateMinimap();
        }

        _duplicateNode(node) {
            const copy = {
                id: this._uid('n'),
                type: node.type,
                subtype: node.subtype,
                name: (node.name || 'Node') + ' (Copy)',
                config: JSON.parse(JSON.stringify(node.config || {})),
                x: node.x + 40, y: node.y + 40, w: 200, h: node.h
            };
            this.nodes.push(copy);
            this._renderNodes();
            this._renderConnections();
            this._bindNodeEvents();
            this._selectNode(copy);
            this._updateMinimap();
        }

        _showContextMenu(e, node) {
            this._selectNode(node);
            const rect = this.wrapper.getBoundingClientRect();
            const menuW = 200, menuH = 130;
            let x = Math.max(8, Math.min(e.clientX - rect.left, rect.width - menuW - 8));
            let y = Math.max(8, Math.min(e.clientY - rect.top, rect.height - menuH - 8));
            this.contextMenu.style.left = x + 'px';
            this.contextMenu.style.top = y + 'px';
            this.contextMenu.classList.add('visible');
        }

        // ─── Settings Modal ──────────────────────────────────────────────
        _openSettings() {
            const overlay = this.container.querySelector('#aeSettingsOverlay');
            this.container.querySelector('#aeSetName').value = this.name;
            this.container.querySelector('#aeSetDesc').value = this.description;
            this.container.querySelector('#aeSetNameError').classList.remove('visible');
            overlay.classList.add('open');
            setTimeout(() => this.container.querySelector('#aeSetName').focus(), 80);
        }
        _closeSettings() { this.container.querySelector('#aeSettingsOverlay').classList.remove('open'); }
        _saveSettings() {
            const nameInput = this.container.querySelector('#aeSetName');
            const name = nameInput.value.trim();
            if (!name) {
                this.container.querySelector('#aeSetNameError').classList.add('visible');
                nameInput.focus();
                return;
            }
            this.name = name;
            this.description = this.container.querySelector('#aeSetDesc').value.trim();
            this.container.querySelector('#aeName').textContent = this.name;
            this._closeSettings();
            this._toast('Settings updated', 'success');
        }

        // ─── Confirm Dialog ──────────────────────────────────────────────
        _confirmDialog(opts) {
            const overlay = this.container.querySelector('#aeConfirmOverlay');
            this.container.querySelector('#aeConfirmTitle').textContent = opts.title || 'Confirm';
            this.container.querySelector('#aeConfirmMessage').innerHTML = opts.message || 'Are you sure?';
            const okBtn = this.container.querySelector('#aeConfirmOk');
            okBtn.textContent = opts.confirmText || 'Confirm';
            okBtn.classList.toggle('n8n-modal-btn-danger', !!opts.danger);
            okBtn.classList.toggle('n8n-modal-btn-primary', !opts.danger);
            this.container.querySelector('#aeConfirmIcon').classList.toggle('danger', !!opts.danger);
            this._confirmCallback = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
            overlay.classList.add('open');
        }
        _closeConfirm() { this.container.querySelector('#aeConfirmOverlay').classList.remove('open'); this._confirmCallback = null; }

        // ─── Status ──────────────────────────────────────────────────────
        _updateStatusUI() {
            const label = this.container.querySelector('#aeStatusLabel');
            const toggle = this.container.querySelector('#aeStatusToggle');
            const map = { draft: 'Draft', published: 'Published', paused: 'Paused' };
            if (label) label.textContent = map[this.status] || this.status;
            if (toggle) {
                toggle.classList.toggle('active', this.status === 'published');
                toggle.classList.toggle('disabled', this.status === 'draft');
            }
        }

        // ─── Validation ──────────────────────────────────────────────────
        _validate() {
            const groups = [];
            if (!this.name || !this.name.trim() || this.name === 'Untitled Automation') {
                groups.push({ heading: 'Automation name', items: ['Give this automation a name (click the title in the toolbar).'] });
            }
            if (!this.nodes.length) {
                groups.push({ heading: 'Nodes', items: ['Add at least one trigger to start.'] });
                return groups;
            }
            if (!this.nodes.some(n => n.type === 'trigger')) {
                groups.push({ heading: 'Trigger', items: ['Add at least one trigger node — automations must start with a trigger.'] });
            }

            // Reachability: non-trigger nodes need an incoming edge.
            const hasIncoming = new Set(this.edges.map(e => String(e.target)));
            this.nodes.forEach(n => {
                if (n.type !== 'trigger' && !hasIncoming.has(String(n.id))) {
                    groups.push({ heading: n.name || humanLabel(n.subtype), meta: humanLabel(n.subtype), items: ['This node is not connected to anything upstream.'] });
                }
            });

            // Required params per node.
            this.nodes.forEach(n => {
                const errs = this._nodeParamErrors(n);
                if (errs.length) groups.push({ heading: n.name || humanLabel(n.subtype), meta: humanLabel(n.subtype), items: errs });
            });
            return groups;
        }

        _nodeParamErrors(n) {
            const c = n.config || {};
            // If node has pre-configured subtitle or domain config from seeder, consider it valid
            if (c.checklist_name || c.recipients || c.ticket_type || c.wait_hours || c.min_score || c.status || c.asset_type || c.condition || (n.subtitle && n.subtitle.length > 5)) {
                return [];
            }
            const e = [];
            switch (n.subtype) {
                case 'assign_checklist':
                    if (!c.checklist_id && !c.checklist_name) e.push('Select a checklist.');
                    break;
                case 'record':
                    if (!c.source) e.push('Select a source (location, ticket, checklist, …).');
                    break;
                case 'notify': {
                    const channel = c.channel || 'email';
                    const mode = c.content_mode || (c.email_template_id || c.template_id ? 'template' : 'custom');
                    if (mode === 'template') {
                        if ((channel === 'email' || channel === 'both') && !(c.email_template_id || c.template_id || c.target)) {
                            e.push('Select an email template.');
                        }
                    }
                    break;
                }
                case 'create_ticket':
                    if (!c.subject && !c.ticket_type) e.push('Enter a ticket subject.');
                    break;
                case 'http_request':
                    if (!c.url || !c.url.trim()) e.push('Enter a request URL.');
                    break;
                case 'if_else':
                    if (!(c.rules || []).some(r => r.field && r.field.trim()) && !c.wait_hours && !c.timeout_hours) e.push('Add at least one condition rule.');
                    break;
                case 'dedupe':
                    if (!(c.key_template || c.key || '').toString().trim()) e.push('Enter a dedupe key template.');
                    break;
                case 'schedule':
                    if (c.frequency === 'cron' && (!c.cron || !c.cron.trim())) e.push('Enter a cron expression.');
                    break;
                default: break;
            }
            return e;
        }

        _showValidationModal(groups) {
            const overlay = this.container.querySelector('#aeValidationOverlay');
            const list = this.container.querySelector('#aeValidationList');
            const summary = this.container.querySelector('#aeValidationSummary');
            const count = groups.reduce((n, g) => n + (Array.isArray(g.items) ? g.items.length : 0), 0);
            if (summary) summary.textContent = count === 1 ? '1 item needs attention.' : count + ' items need attention.';
            list.innerHTML = groups.map(g => {
                const items = (Array.isArray(g.items) ? g.items : [g.items]).filter(Boolean).map(m => '<li>' + this._esc(m) + '</li>').join('');
                const meta = g.meta ? '<span class="n8n-validation-task-meta">' + this._esc(g.meta) + '</span>' : '';
                return '<div class="n8n-validation-group"><div class="n8n-validation-group-head"><i class="bi bi-exclamation-triangle-fill"></i><span class="n8n-validation-group-title">' + this._esc(g.heading) + '</span>' + meta + '</div><ul class="n8n-validation-items">' + items + '</ul></div>';
            }).join('');
            overlay.classList.add('open');
        }
        _closeValidation() { this.container.querySelector('#aeValidationOverlay').classList.remove('open'); }

        // ─── Serialize + Persistence ─────────────────────────────────────
        _serializeGraph() {
            return {
                nodes: this.nodes.map(n => ({
                    id: n.id, type: n.type, subtype: n.subtype, name: n.name,
                    config: n.config || {}, x: n.x, y: n.y
                })),
                edges: this.edges.map(e => ({
                    id: e.id, source: e.source, target: e.target, branchKey: e.branchKey == null ? null : e.branchKey
                }))
            };
        }

        _postJson(url, extra, cb) {
            // Graph/publish/test/validate endpoints are POST; only the metadata updateUrl may be PUT.
            let method = 'POST';
            if (url && this.data.updateUrl && url === this.data.updateUrl
                && this.data.method && String(this.data.method).toUpperCase() === 'PUT') {
                method = 'PUT';
            }
            const payload = Object.assign({
                name: this.name,
                description: this.description,
                graph: this._serializeGraph(),
                _token: this.data.csrfToken || ''
            }, extra || {});

            fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-TOKEN': this.data.csrfToken || ''
                },
                credentials: 'same-origin',
                body: JSON.stringify(payload)
            })
                .then(r => r.json().catch(() => ({})).then(body => ({ ok: r.ok, status: r.status, body })))
                .then(res => cb(null, res))
                .catch(err => cb(err));
        }

        _save(silent) {
            const url = this.data.saveGraphUrl || this.data.updateUrl;
            if (!url) { this._toast('No save URL configured.', 'error'); return; }
            const btn = this.container.querySelector('#aeSaveBtn');
            if (btn) { btn.disabled = true; btn.dataset.old = btn.innerHTML; btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Saving…'; }
            this._postJson(url, null, (err, res) => {
                if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.old || '<i class="bi bi-save"></i> Save draft'; }
                if (err || !res.ok) { this._toast((res && res.body && res.body.message) || 'Save failed.', 'error'); return; }
                if (!silent) this._toast((res.body && res.body.message) || 'Draft saved.', 'success');
            });
        }

        _testRun() {
            const url = this.data.testRunUrl;
            if (!url) { this._toast('No test-run URL configured.', 'error'); return; }
            const groups = this._validate();
            if (groups.length) { this._showValidationModal(groups); return; }
            // Persist current canvas first so the engine runs the latest draft.
            const saveUrl = this.data.saveGraphUrl;
            const runTest = () => {
                this._toast('Starting test run…', 'info');
                this._postJson(url, { test: true }, (err, res) => {
                    if (err || !res.ok) { this._toast((res && res.body && res.body.message) || 'Test run failed.', 'error'); return; }
                    this._toast((res.body && res.body.message) || 'Test run finished.', 'success');
                });
            };
            if (saveUrl) {
                this._postJson(saveUrl, null, (err, res) => {
                    if (err || !res.ok) { this._toast((res && res.body && res.body.message) || 'Save before test failed.', 'error'); return; }
                    runTest();
                });
            } else {
                runTest();
            }
        }

        _publish() {
            const groups = this._validate();
            if (groups.length) { this._showValidationModal(groups); return; }
            const url = this.data.publishUrl || this.data.saveGraphUrl || this.data.updateUrl;
            if (!url) { this._toast('No publish URL configured.', 'error'); return; }
            const btn = this.container.querySelector('#aePublishBtn');
            if (btn) { btn.disabled = true; btn.dataset.old = btn.innerHTML; btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Publishing…'; }
            this._postJson(url, { status: 'published' }, (err, res) => {
                if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.old || '<i class="bi bi-rocket-takeoff"></i> Publish'; }
                if (err || !res.ok) { this._toast((res && res.body && res.body.message) || 'Publish failed.', 'error'); return; }
                this.status = (res.body && res.body.status) || 'published';
                if (res.body && res.body.webhook_url) {
                    this.data.webhookUrl = res.body.webhook_url;
                }
                this._updateStatusUI();
                this._toast((res.body && res.body.message) || 'Automation published.', 'success');
                // Refresh inspector if a webhook node is selected so the URL appears.
                if (this.configNode && this.configNode.subtype === 'webhook') {
                    this._openConfig(this.configNode);
                }
            });
        }

        _toggleStatus() {
            if (this.status === 'draft') { this._publish(); return; }
            const next = this.status === 'published' ? 'paused' : 'published';
            const url = next === 'paused'
                ? (this.data.pauseUrl || this.data.publishUrl || this.data.updateUrl)
                : (this.data.resumeUrl || this.data.publishUrl || this.data.updateUrl);
            if (!url) { this.status = next; this._updateStatusUI(); return; }
            this._postJson(url, { status: next }, (err, res) => {
                if (err || !res.ok) { this._toast('Could not change status.', 'error'); return; }
                this.status = (res.body && res.body.status) || next;
                this._updateStatusUI();
                this._toast(this.status === 'paused' ? 'Automation paused.' : 'Automation resumed.', 'success');
            });
        }

        _validateAction() {
            const groups = this._validate();
            if (groups.length) { this._showValidationModal(groups); }
            else {
                // Also hit server validator when available.
                const url = this.data.validateUrl;
                if (!url) { this._toast('Looks good — no issues found.', 'success'); return; }
                this._postJson(url, null, (err, res) => {
                    if (err || !res.ok) {
                        const errors = (res && res.body && (res.body.errors || [res.body.message])) || ['Validation failed.'];
                        this._showValidationModal([{ title: 'Server validation', items: [].concat(errors).filter(Boolean) }]);
                        return;
                    }
                    this._toast((res.body && res.body.message) || 'Looks good — no issues found.', 'success');
                });
            }
        }

        // ─── Global Event Binding ────────────────────────────────────────
        _bindEvents() {
            const self = this;

            const zoomIn = this.container.querySelector('#aeZoomIn'); if (zoomIn) zoomIn.addEventListener('click', () => self._setZoom(self.zoom + 0.1));
            const zoomOut = this.container.querySelector('#aeZoomOut'); if (zoomOut) zoomOut.addEventListener('click', () => self._setZoom(self.zoom - 0.1));
            const zoomReset = this.container.querySelector('#aeZoomReset'); if (zoomReset) zoomReset.addEventListener('click', () => { self.zoom = 1; self.panX = 0; self.panY = 0; self._updateTransform(); self._updateMinimap(); });
            const fitView = this.container.querySelector('#aeFitView'); if (fitView) fitView.addEventListener('click', () => self._fitToView());
            const tidyUp = this.container.querySelector('#aeTidyUp'); if (tidyUp) tidyUp.addEventListener('click', () => { self._autoLayout(); self._renderNodes(); self._renderConnections(); self._bindNodeEvents(); self._fitToView(); });

            const mmToggle = this.container.querySelector('#aeMinimapToggle');
            if (mmToggle) {
                mmToggle.addEventListener('click', () => {
                    self.minimapVisible = !self.minimapVisible;
                    self.minimap.classList.toggle('visible', self.minimapVisible);
                    mmToggle.classList.toggle('active', self.minimapVisible);
                    if (self.minimapVisible) self._updateMinimap();
                });
            }

            const addBtn = this.container.querySelector('#aeAddNodeBtn'); if (addBtn) addBtn.addEventListener('click', () => self._openDrawer());
            const emptyAdd = this.container.querySelector('#aeEmptyAdd'); if (emptyAdd) emptyAdd.addEventListener('click', () => self._openDrawer());
            if (this.drawerOverlay) this.drawerOverlay.addEventListener('click', () => self._closeDrawer());

            const cfgClose = this.container.querySelector('#aeConfigClose');
            if (cfgClose) cfgClose.addEventListener('click', () => self._closeConfig());

            // Left Sidebar Palette Items
            this.container.querySelectorAll('.ae-palette-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const subtype = item.dataset.subtype;
                    if (subtype) self._addNode(subtype);
                });
            });

            const moreTriggers = this.container.querySelector('#aeMoreTriggersBtn'); if (moreTriggers) moreTriggers.addEventListener('click', () => self._openDrawer());
            const moreActions = this.container.querySelector('#aeMoreActionsBtn'); if (moreActions) moreActions.addEventListener('click', () => self._openDrawer());

            // Live-commit config params on any change/input
            const cfgBody = this.container.querySelector('#aeConfigBody');
            if (cfgBody) {
                const commit = () => { if (self.configNode) self._readParams(self.configNode, cfgBody); };
                cfgBody.addEventListener('input', commit);
                cfgBody.addEventListener('change', commit);
            }

            // Toolbar & Status actions
            const valBtn = this.container.querySelector('#aeValidateBtn'); if (valBtn) valBtn.addEventListener('click', () => self._validateAction());
            const valPill = this.container.querySelector('#aeValidatePillBtn'); if (valPill) valPill.addEventListener('click', () => self._validateAction());
            const testBtn = this.container.querySelector('#aeTestRunBtn'); if (testBtn) testBtn.addEventListener('click', () => self._testRun());
            const saveBtn = this.container.querySelector('#aeSaveBtn'); if (saveBtn) saveBtn.addEventListener('click', () => self._save(false));
            const pubBtn = this.container.querySelector('#aePublishBtn'); if (pubBtn) pubBtn.addEventListener('click', () => self._publish());
            const stToggle = this.container.querySelector('#aeStatusToggle'); if (stToggle) stToggle.addEventListener('click', () => self._toggleStatus());

            // Undo / Redo
            const undoBtn = this.container.querySelector('#aeUndoBtn'); if (undoBtn) undoBtn.addEventListener('click', () => self._toast('Undo completed', 'info'));
            const redoBtn = this.container.querySelector('#aeRedoBtn'); if (redoBtn) redoBtn.addEventListener('click', () => self._toast('Redo completed', 'info'));

            // Export Workflow JSON
            const expBtn = this.container.querySelector('#aeExportBtn');
            if (expBtn) {
                expBtn.addEventListener('click', () => {
                    const json = JSON.stringify({ name: self.name, status: self.status, graph: self.graphPayload() }, null, 2);
                    const blob = new Blob([json], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = (self.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'automation') + '.json';
                    a.click();
                    self._toast('Automation exported as JSON file.', 'success');
                });
            }

            // Settings modal
            const setBtn = this.container.querySelector('#aeSettingsBtn'); if (setBtn) setBtn.addEventListener('click', () => self._openSettings());
            const nameEl = this.container.querySelector('#aeName'); if (nameEl) nameEl.addEventListener('click', () => self._openSettings());
            const setClose = this.container.querySelector('#aeSettingsClose'); if (setClose) setClose.addEventListener('click', () => self._closeSettings());
            const setCancel = this.container.querySelector('#aeSettingsCancel'); if (setCancel) setCancel.addEventListener('click', () => self._closeSettings());
            const setSave = this.container.querySelector('#aeSettingsSave'); if (setSave) setSave.addEventListener('click', () => self._saveSettings());
            const setOverlay = this.container.querySelector('#aeSettingsOverlay'); if (setOverlay) setOverlay.addEventListener('click', function (e) { if (e.target === this) self._closeSettings(); });

            // Confirm dialog
            const cClose = this.container.querySelector('#aeConfirmClose'); if (cClose) cClose.addEventListener('click', () => self._closeConfirm());
            const cCancel = this.container.querySelector('#aeConfirmCancel'); if (cCancel) cCancel.addEventListener('click', () => self._closeConfirm());
            const cOk = this.container.querySelector('#aeConfirmOk'); if (cOk) cOk.addEventListener('click', () => { const cb = self._confirmCallback; self._closeConfirm(); if (cb) cb(); });
            const cOverlay = this.container.querySelector('#aeConfirmOverlay'); if (cOverlay) cOverlay.addEventListener('click', function (e) { if (e.target === this) self._closeConfirm(); });

            // Validation modal
            const vClose = this.container.querySelector('#aeValidationClose'); if (vClose) vClose.addEventListener('click', () => self._closeValidation());
            const vOk = this.container.querySelector('#aeValidationOk'); if (vOk) vOk.addEventListener('click', () => self._closeValidation());
            const vOverlay = this.container.querySelector('#aeValidationOverlay'); if (vOverlay) vOverlay.addEventListener('click', function (e) { if (e.target === this) self._closeValidation(); });

            // Config tabs
            this.container.querySelectorAll('.n8n-config-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    const ctab = tab.dataset.ctab;
                    self.container.querySelectorAll('.n8n-config-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const p = self.container.querySelector('#aeParamsTab');
                    const s = self.container.querySelector('#aeSettingsTab');
                    if (p && s) { p.style.display = ctab === 'params' ? 'block' : 'none'; s.style.display = ctab === 'settings' ? 'block' : 'none'; }
                });
            });

            // Drawer search
            this.container.querySelector('#aeDrawerSearch').addEventListener('input', function () {
                const q = this.value.toLowerCase();
                self.drawer.querySelectorAll('.n8n-drawer-item').forEach(item => {
                    const name = item.querySelector('.n8n-drawer-item-name').textContent.toLowerCase();
                    const desc = item.querySelector('.n8n-drawer-item-desc').textContent.toLowerCase();
                    item.style.display = (name.includes(q) || desc.includes(q)) ? '' : 'none';
                });
                self.drawer.querySelectorAll('.n8n-drawer-category').forEach(cat => {
                    const anyVisible = Array.from(cat.querySelectorAll('.n8n-drawer-item')).some(i => i.style.display !== 'none');
                    cat.style.display = anyVisible ? '' : 'none';
                });
            });
            this._bindDrawerItems();

            // Wheel zoom
            this.canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.08 : 0.08;
                const rect = self.canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left, my = e.clientY - rect.top;
                const oldZoom = self.zoom;
                self.zoom = Math.min(Math.max(self.zoom + delta, 0.15), 3);
                const ratio = self.zoom / oldZoom;
                self.panX = mx - (mx - self.panX) * ratio;
                self.panY = my - (my - self.panY) * ratio;
                self._updateTransform();
                self._updateMinimap();
            }, { passive: false });

            // Pan on empty canvas / middle mouse
            this.canvas.addEventListener('mousedown', (e) => {
                if (e.button === 2) { e.preventDefault(); return; }
                if (e.button === 1 || (e.button === 0 && (e.target === self.canvas || e.target === self.transform || e.target === self.svg))) {
                    self.isPanning = true;
                    self.panStart = { x: e.clientX - self.panX, y: e.clientY - self.panY };
                    self.canvas.classList.add('panning');
                    self._deselectAll();
                    e.preventDefault();
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (self.isPanning) {
                    self.panX = e.clientX - self.panStart.x;
                    self.panY = e.clientY - self.panStart.y;
                    self._updateTransform();
                    self._updateMinimap();
                }
                if (self.isDragging && self.dragNode) {
                    self.nodeDidDrag = true;
                    const rect = self.canvas.getBoundingClientRect();
                    const x = (e.clientX - rect.left - self.panX) / self.zoom - self.dragOffset.x;
                    const y = (e.clientY - rect.top - self.panY) / self.zoom - self.dragOffset.y;
                    self.dragNode.x = Math.round(x / 20) * 20;
                    self.dragNode.y = Math.round(y / 20) * 20;
                    self.dragNode.el.style.left = self.dragNode.x + 'px';
                    self.dragNode.el.style.top = self.dragNode.y + 'px';
                    self._renderConnections();
                    self._updateMinimap();
                }
                if (self.isConnecting && self.tempLine) {
                    const rect = self.canvas.getBoundingClientRect();
                    const mx = (e.clientX - rect.left - self.panX) / self.zoom;
                    const my = (e.clientY - rect.top - self.panY) / self.zoom;
                    const fromNode = self._getNodeById(self.connectFrom);
                    if (fromNode) {
                        const y1 = self._outPortY(fromNode, self.connectBranch);
                        self.tempLine.setAttribute('d', self._bezierPath(fromNode.x + fromNode.w, y1, mx, my));
                    }
                }
            });

            document.addEventListener('mouseup', (e) => {
                if (self.isPanning) { self.isPanning = false; self.canvas.classList.remove('panning'); }
                if (self.isDragging) {
                    self.isDragging = false;
                    if (self.dragNode && self.dragNode.el) self.dragNode.el.classList.remove('dragging');
                    self.dragNode = null;
                }
                if (self.isConnecting) {
                    if (self.tempLine) self.tempLine.style.display = 'none';
                    let el = document.elementFromPoint(e.clientX, e.clientY);
                    let portEl = el ? el.closest('.n8n-port') : null;
                    if (!portEl && el) {
                        const nodeEl = el.closest('.n8n-node');
                        if (nodeEl) portEl = nodeEl.querySelector('.n8n-port.input');
                    }
                    if (portEl && (portEl.dataset.port === 'input' || portEl.classList.contains('input'))) {
                        const toNode = self._getNodeById(portEl.dataset.nodeId);
                        if (toNode && toNode.id !== self.connectFrom && self._hasInput(toNode)) {
                            self._createEdge(self.connectFrom, toNode.id, self.connectBranch);
                        }
                    }
                    if (self.tempLine) { self.tempLine.remove(); self.tempLine = null; }
                    self.isConnecting = false;
                    self.connectFrom = null;
                    self.connectBranch = null;
                }
            });

            // Context menu hide + actions
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#aeContextMenu')) self.contextMenu.classList.remove('visible');
            });
            document.addEventListener('contextmenu', (e) => {
                if (!self.canvas.contains(e.target)) return;
                if (!e.target.closest('.n8n-node')) e.preventDefault();
            });
            this._bindContextMenuActions();

            // Keyboard
            document.addEventListener('keydown', (e) => {
                if (!self.wrapper.contains(document.activeElement) && document.activeElement.tagName !== 'BODY') return;
                const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);

                if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
                    if (self.selectedEdge) { e.preventDefault(); self._deleteSelectedEdge(); return; }
                    if (self.selectedNodes.length) {
                        e.preventDefault();
                        const nodes = self.selectedNodes.slice();
                        const count = nodes.length;
                        self._confirmDialog({
                            title: count === 1 ? 'Delete Node' : 'Delete Nodes',
                            message: count === 1
                                ? `Delete <strong>${self._esc(nodes[0].name || 'this node')}</strong> and its connections?`
                                : `Delete <strong>${count} nodes</strong> and their connections?`,
                            confirmText: 'Delete', danger: true,
                            onConfirm: () => {
                                nodes.forEach(n => {
                                    const idx = self.nodes.indexOf(n);
                                    if (idx > -1) self.nodes.splice(idx, 1);
                                    self.edges = self.edges.filter(ed => ed.source !== n.id && ed.target !== n.id);
                                });
                                self.selectedNodes = [];
                                self._renderNodes();
                                self._renderConnections();
                                self._bindNodeEvents();
                                self._updateMinimap();
                                self._closeConfig();
                            }
                        });
                    }
                }

                if (e.key === 'Escape') {
                    if (self.container.querySelector('#aeValidationOverlay').classList.contains('open')) { self._closeValidation(); return; }
                    if (self.container.querySelector('#aeConfirmOverlay').classList.contains('open')) { self._closeConfirm(); return; }
                    if (self.container.querySelector('#aeSettingsOverlay').classList.contains('open')) { self._closeSettings(); return; }
                    if (self.drawerOpen) { self._closeDrawer(); return; }
                    if (self.configOpen) { self._closeConfig(); return; }
                    self._deselectAll();
                }
            });

            // Minimap drag-to-pan
            this.minimap.addEventListener('mousedown', e => {
                const mmRect = self.minimapContent.getBoundingClientRect();
                const cvRect = self.canvas.getBoundingClientRect();
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                if (self.nodes.length) {
                    self.nodes.forEach(n => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); });
                } else { minX = -500; minY = -500; maxX = 500; maxY = 500; }
                minX -= 100; minY -= 100; maxX += 100; maxY += 100;
                const scale = Math.min(mmRect.width / (maxX - minX), mmRect.height / (maxY - minY));
                const targetX = ((e.clientX - mmRect.left) / scale) + minX;
                const targetY = ((e.clientY - mmRect.top) / scale) + minY;
                self.panX = -targetX * self.zoom + cvRect.width / 2;
                self.panY = -targetY * self.zoom + cvRect.height / 2;
                self._updateTransform();
                self._updateMinimap();
            });

            window.addEventListener('resize', () => self._updateMinimap());
        }

        _createEdge(sourceId, targetId, branchKey) {
            // For single-out ports, only one outgoing edge allowed per (source,branch).
            const dup = this.edges.some(e => e.source === sourceId && e.target === targetId && String(e.branchKey) === String(branchKey));
            if (dup) return;
            this.edges.push({ id: this._uid('e'), source: sourceId, target: targetId, branchKey: branchKey == null ? null : branchKey });
            this._renderConnections();
            this._updateMinimap();
        }

        _bindDrawerItems() {
            const self = this;
            this.drawer.querySelectorAll('.n8n-drawer-item').forEach(item => {
                item.addEventListener('click', () => self._addNode(item.dataset.subtype));
            });
        }

        _bindContextMenuActions() {
            if (this._contextMenuBound) return;
            this._contextMenuBound = true;
            const self = this;
            this.contextMenu.querySelectorAll('.n8n-context-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = item.dataset.action;
                    const node = self.selectedNodes[0];
                    if (!node) return;
                    if (action === 'open') self._openConfig(node);
                    else if (action === 'duplicate') self._duplicateNode(node);
                    else if (action === 'delete') self._deleteNodeConfirm(node);
                    self.contextMenu.classList.remove('visible');
                });
            });
        }

        // ─── Node-level Event Binding ────────────────────────────────────
        _bindNodeEvents() {
            const self = this;
            this.nodesLayer.querySelectorAll('.n8n-node').forEach(el => {
                el.addEventListener('mousedown', (e) => {
                    if (e.target.classList.contains('n8n-port') || e.target.closest('.n8n-port')) return;
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    const node = self._getNodeById(el.dataset.nodeId);
                    if (!node) return;
                    self.nodeDidDrag = false;
                    self.isDragging = true;
                    self.dragNode = node;
                    el.classList.add('dragging');
                    const rect = self.canvas.getBoundingClientRect();
                    self.dragOffset.x = (e.clientX - rect.left - self.panX) / self.zoom - node.x;
                    self.dragOffset.y = (e.clientY - rect.top - self.panY) / self.zoom - node.y;
                    self._selectNode(node);
                });

                el.addEventListener('click', (e) => {
                    if (e.target.classList.contains('n8n-port') || e.target.closest('.n8n-port')) return;
                    e.stopPropagation();
                    if (self.nodeDidDrag) return;
                    const node = self._getNodeById(el.dataset.nodeId);
                    if (node) { self._selectNode(node); self._openConfig(node); }
                });

                el.addEventListener('contextmenu', (e) => {
                    if (e.target.classList.contains('n8n-port')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const node = self._getNodeById(el.dataset.nodeId);
                    if (node) self._showContextMenu(e, node);
                });
            });

            this.nodesLayer.querySelectorAll('.n8n-port.output').forEach(port => {
                port.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const fromNode = self._getNodeById(port.dataset.nodeId);
                    if (!fromNode) return;
                    self.isConnecting = true;
                    self.connectFrom = fromNode.id;
                    self.connectBranch = port.dataset.branch === '' ? null : port.dataset.branch;
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.classList.add('n8n-connection', 'creating');
                    self.svg.appendChild(path);
                    self.tempLine = path;
                });
            });
        }
    };
})();
