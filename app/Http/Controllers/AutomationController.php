<?php

namespace App\Http\Controllers;

use App\Models\Automation;
use App\Models\AutomationApproval;
use App\Models\AutomationRun;
use App\Models\ChecklistScheduling;
use App\Models\ChecklistTask;
use App\Models\Role;
use App\Services\Automation\ApprovalService;
use App\Services\Automation\AutomationEngine;
use App\Services\Automation\AutomationGraphValidator;
use App\Services\Automation\AutomationPublisher;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class AutomationController extends Controller
{
    public function __construct(
        private readonly AutomationPublisher $publisher,
        private readonly AutomationGraphValidator $validator,
        private readonly AutomationEngine $engine,
        private readonly ApprovalService $approvalService
    ) {
    }

    public function index(Request $request)
    {
        if ($request->ajax()) {
            return datatables()
                ->eloquent(
                    Automation::query()
                        ->with(['creator:id,name', 'currentVersion'])
                        ->withCount('runs')
                        ->latest()
                )
                ->addColumn('status_badge', function (Automation $row) {
                    return $this->statusBadge($row->status);
                })
                ->addColumn('version', function (Automation $row) {
                    return $row->currentVersion
                        ? 'v'.$row->currentVersion->version_number
                        : '—';
                })
                ->editColumn('updated_at', function (Automation $row) {
                    return optional($row->updated_at)->format('d-m-Y H:i') ?: '—';
                })
                ->addColumn('action', function (Automation $row) {
                    $html = '';
                    if (auth()->user()->can('automations.show')) {
                        $html .= '<a href="'.route('automations.show', $row).'" class="btn btn-warning btn-sm me-1">Show</a>';
                    }
                    if (auth()->user()->can('automations.canvas')) {
                        $html .= '<a href="'.route('automations.canvas', $row).'" class="btn btn-info btn-sm me-1 text-white"><i class="bi bi-diagram-3"></i> Canvas</a>';
                    }
                    if (auth()->user()->can('automations.runs.index')) {
                        $html .= '<a href="'.route('automations.runs.index', $row).'" class="btn btn-secondary btn-sm me-1">Runs</a>';
                    }
                    if (auth()->user()->can('automations.destroy')) {
                        $html .= '<form method="POST" action="'.route('automations.destroy', $row).'" style="display:inline" class="delete-automation-form">'
                            .csrf_field().method_field('DELETE')
                            .'<button type="submit" class="btn btn-danger btn-sm deleteAutomation">Delete</button></form>';
                    }

                    return $html;
                })
                ->rawColumns(['status_badge', 'action'])
                ->addIndexColumn()
                ->toJson();
        }

        return view('automations.index', [
            'page_title' => 'Automations',
            'page_description' => 'Event-driven automations — triggers, conditions, actions, waits, approvals.',
        ]);
    }

    public function create()
    {
        return $this->canvasCreate();
    }

    public function canvasCreate()
    {
        $automation = Automation::create([
            'name' => 'Untitled automation',
            'status' => Automation::STATUS_DRAFT,
            'created_by' => auth()->id(),
            'updated_by' => auth()->id(),
        ]);

        $graph = $this->publisher->emptyStarterGraph();
        $this->publisher->saveDraft($automation, $graph, userId: auth()->id());

        return redirect()->route('automations.canvas', $automation);
    }

    public function canvas(Automation $automation)
    {
        $automation->load(['currentVersion', 'creator']);

        return view('automations.canvas', $this->canvasPayload($automation));
    }

    public function edit(Automation $automation)
    {
        return redirect()->route('automations.canvas', $automation);
    }

    public function show(Automation $automation)
    {
        $automation->load(['currentVersion', 'activeSchedule', 'creator']);
        $recentRuns = $automation->runs()->limit(15)->get();
        $versions = $automation->versions()->whereNotNull('published_at')->with('publisher')->orderByDesc('version_number')->get();

        return view('automations.show', [
            'page_title' => $automation->name,
            'page_description' => 'Automation details and recent activity.',
            'automation' => $automation,
            'graph' => $this->publisher->latestGraph($automation),
            'recentRuns' => $recentRuns,
            'versions' => $versions,
            'webhookUrl' => $automation->webhook_token
                ? url('/api/automations/webhook/'.$automation->webhook_token)
                : null,
        ]);
    }

    public function update(Request $request, Automation $automation)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'description' => ['nullable', 'string', 'max:5000'],
        ]);

        $automation->update([
            'name' => trim($data['name']),
            'description' => $data['description'] ?? null,
            'updated_by' => auth()->id(),
        ]);

        if ($request->wantsJson()) {
            return response()->json(['ok' => true, 'message' => 'Saved.', 'automation' => $automation->fresh()]);
        }

        return back()->with('success', 'Automation updated.');
    }

    public function saveGraph(Request $request, Automation $automation)
    {
        $data = $request->validate([
            'name' => ['nullable', 'string', 'max:255'],
            'description' => ['nullable', 'string', 'max:5000'],
            'graph' => ['required', 'array'],
            'graph.nodes' => ['present', 'array'],
            'graph.edges' => ['present', 'array'],
        ]);

        if (! empty($data['name'])) {
            $automation->name = trim($data['name']);
        }
        if (array_key_exists('description', $data)) {
            $automation->description = $data['description'];
        }
        $automation->updated_by = auth()->id();
        $automation->save();

        $this->publisher->saveDraft($automation, $data['graph'], userId: auth()->id());

        return response()->json([
            'ok' => true,
            'message' => 'Draft saved.',
            'graph' => $this->publisher->latestGraph($automation->fresh()),
        ]);
    }

    public function validateGraph(Request $request, Automation $automation)
    {
        $graph = $request->input('graph');
        if (! is_array($graph)) {
            $graph = $this->publisher->latestGraph($automation);
        }

        $result = $this->validator->validate($graph);

        return response()->json($result, $result['ok'] ? 200 : 422);
    }

    public function publish(Request $request, Automation $automation)
    {
        $data = $request->validate([
            'graph' => ['nullable', 'array'],
            'changelog' => ['nullable', 'string', 'max:500'],
        ]);

        try {
            if (! empty($data['graph'])) {
                $this->publisher->saveDraft($automation, $data['graph'], userId: auth()->id());
            }

            $version = $this->publisher->publish(
                $automation->fresh(),
                $data['graph'] ?? null,
                auth()->id(),
                $data['changelog'] ?? null
            );

            return response()->json([
                'ok' => true,
                'message' => 'Published v'.$version->version_number.'.',
                'version' => $version->version_number,
                'status' => $automation->fresh()->status,
                'webhook_url' => $automation->fresh()->webhook_token
                    ? url('/api/automations/webhook/'.$automation->fresh()->webhook_token)
                    : null,
            ]);
        } catch (\Throwable $e) {
            Log::warning('Automation publish failed', ['id' => $automation->id, 'error' => $e->getMessage()]);

            return response()->json(['ok' => false, 'message' => $e->getMessage()], 422);
        }
    }

    public function pause(Automation $automation)
    {
        $automation->update([
            'status' => Automation::STATUS_PAUSED,
            'updated_by' => auth()->id(),
        ]);
        $automation->schedules()->update(['is_active' => false]);

        if (request()->wantsJson()) {
            return response()->json(['ok' => true, 'status' => 'paused']);
        }

        return back()->with('success', 'Automation paused.');
    }

    public function resume(Automation $automation)
    {
        if (! $automation->current_version_id) {
            if (request()->wantsJson()) {
                return response()->json(['ok' => false, 'message' => 'Publish before resuming.'], 422);
            }

            return back()->with('error', 'Publish before resuming.');
        }

        $automation->update([
            'status' => Automation::STATUS_PUBLISHED,
            'updated_by' => auth()->id(),
        ]);
        $automation->schedules()->update(['is_active' => true]);

        if (request()->wantsJson()) {
            return response()->json(['ok' => true, 'status' => 'published']);
        }

        return back()->with('success', 'Automation resumed.');
    }

    public function testRun(Automation $automation)
    {
        try {
            $run = $this->engine->start(
                $automation->fresh(),
                'test',
                ['manual' => true],
                [],
                auth()->id(),
                queue: false
            );

            return response()->json([
                'ok' => true,
                'message' => 'Test run finished: '.$run->status,
                'run' => [
                    'id' => $run->id,
                    'uuid' => $run->uuid,
                    'status' => $run->status,
                    'error_message' => $run->error_message,
                    'url' => route('automations.runs.show', [$automation, $run]),
                ],
            ]);
        } catch (\Throwable $e) {
            return response()->json(['ok' => false, 'message' => $e->getMessage()], 422);
        }
    }

    public function webhook(Request $request, string $token)
    {
        $automation = Automation::query()->where('webhook_token', $token)->first();
        if (! $automation || ! $automation->canExecute()) {
            return response()->json(['ok' => false, 'message' => 'Webhook not available.'], 404);
        }

        if (! empty($automation->webhook_secret)) {
            $signature = (string) $request->header('X-Automation-Signature', '');
            $expected = hash_hmac('sha256', $request->getContent(), $automation->webhook_secret);
            if (! hash_equals($expected, $signature) && $request->input('secret') !== $automation->webhook_secret) {
                return response()->json(['ok' => false, 'message' => 'Invalid signature.'], 401);
            }
        }

        $payload = $request->all();
        unset($payload['secret']);

        $run = $this->engine->start(
            $automation,
            'webhook',
            $payload,
            ['webhook_payload' => $payload],
            null,
            false
        );

        return response()->json([
            'ok' => true,
            'run_uuid' => $run->uuid,
            'status' => $run->status,
        ]);
    }

    public function destroy(Automation $automation)
    {
        $automation->schedules()->update(['is_active' => false]);
        $automation->delete();

        return redirect()->route('automations.index')->with('success', 'Automation deleted.');
    }

    public function runsGlobal(Request $request)
    {
        if ($request->ajax()) {
            return datatables()
                ->eloquent(
                    AutomationRun::query()->with(['automation:id,name', 'triggeredByUser:id,name'])->latest()
                )
                ->addColumn('automation_name', fn (AutomationRun $row) => $row->automation->name ?? '—')
                ->addColumn('status_badge', fn (AutomationRun $row) => $this->runStatusBadge($row->status))
                ->addColumn('started', fn (AutomationRun $row) => optional($row->started_at)->format('d-m-Y H:i') ?: '—')
                ->addColumn('action', function (AutomationRun $row) {
                    if (! $row->automation_id || ! auth()->user()->can('automations.runs.show')) {
                        return '';
                    }

                    return '<a href="'.route('automations.runs.show', [$row->automation_id, $row]).'" class="btn btn-info btn-sm">Details</a>';
                })
                ->rawColumns(['status_badge', 'action'])
                ->addIndexColumn()
                ->toJson();
        }

        return view('automations.runs.global', [
            'page_title' => 'Automation Run Log',
            'page_description' => 'All automation executions across the workspace.',
        ]);
    }

    public function runsIndex(Request $request, Automation $automation)
    {
        if ($request->ajax()) {
            return datatables()
                ->eloquent($automation->runs()->with('triggeredByUser')->getQuery())
                ->addColumn('status_badge', fn (AutomationRun $row) => $this->runStatusBadge($row->status))
                ->addColumn('started', fn (AutomationRun $row) => optional($row->started_at)->format('d-m-Y H:i') ?: '—')
                ->addColumn('finished', fn (AutomationRun $row) => optional($row->finished_at)->format('d-m-Y H:i') ?: '—')
                ->addColumn('action', function (AutomationRun $row) use ($automation) {
                    if (! auth()->user()->can('automations.runs.show')) {
                        return '';
                    }

                    return '<a href="'.route('automations.runs.show', [$automation, $row]).'" class="btn btn-info btn-sm">Details</a>';
                })
                ->rawColumns(['status_badge', 'action'])
                ->addIndexColumn()
                ->toJson();
        }

        return view('automations.runs.index', [
            'page_title' => 'Runs — '.$automation->name,
            'page_description' => 'Execution history for this automation.',
            'automation' => $automation,
        ]);
    }

    public function runsShow(Automation $automation, AutomationRun $run)
    {
        abort_unless((int) $run->automation_id === (int) $automation->id, 404);
        $run->load('steps');

        return view('automations.runs.show', [
            'page_title' => 'Run '.$run->uuid,
            'page_description' => $automation->name,
            'automation' => $automation,
            'run' => $run,
        ]);
    }

    public function approvalsIndex(Request $request)
    {
        $query = AutomationApproval::query()
            ->with(['automation:id,name', 'run:id,uuid,status'])
            ->latest();

        if (! \App\Models\User::isAdmin()) {
            $uid = (int) auth()->id();
            $query->where(function ($q) use ($uid) {
                $q->whereJsonContains('approver_user_ids', $uid)
                    ->orWhereJsonContains('approver_user_ids', (string) $uid);
            });
        }

        if ($request->ajax()) {
            return datatables()
                ->eloquent($query)
                ->addColumn('automation_name', fn (AutomationApproval $row) => $row->automation->name ?? '—')
                ->addColumn('status_badge', fn (AutomationApproval $row) => $this->statusBadge($row->status))
                ->addColumn('action', function (AutomationApproval $row) {
                    if (! $row->isPending() || ! auth()->user()->can('automations.approvals.decide')) {
                        return '';
                    }

                    return '<a href="'.route('automations.approvals.show', $row).'" class="btn btn-info btn-sm">Review</a>';
                })
                ->rawColumns(['status_badge', 'action'])
                ->addIndexColumn()
                ->toJson();
        }

        return view('automations.approvals.index', [
            'page_title' => 'Automation Approvals',
            'page_description' => 'Pending and historical approval gates.',
        ]);
    }

    public function approvalsShow(AutomationApproval $approval)
    {
        $approval->load(['automation', 'run.steps', 'decidedByUser']);

        return view('automations.approvals.show', [
            'page_title' => 'Approval #'.$approval->id,
            'page_description' => $approval->automation->name ?? '',
            'approval' => $approval,
        ]);
    }

    public function approvalsDecide(Request $request, AutomationApproval $approval)
    {
        $data = $request->validate([
            'decision' => ['required', 'in:approved,rejected'],
            'comment' => ['nullable', 'string', 'max:2000'],
        ]);

        try {
            $approval = $this->approvalService->decide(
                $approval,
                auth()->id(),
                $data['decision'],
                $data['comment'] ?? null
            );

            app(\App\Services\Automation\AutomationEventResumer::class)
                ->onApprovalDecided($approval);

            return redirect()
                ->route('automations.approvals.index')
                ->with('success', 'Decision recorded: '.$data['decision']);
        } catch (\Throwable $e) {
            return back()->with('error', $e->getMessage());
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function canvasPayload(Automation $automation): array
    {
        $roles = Role::query()
            ->where('assignable_to_checklists', true)
            ->orderBy('name')
            ->get(['id', 'name']);

        return [
            'page_title' => 'Automation Canvas',
            'page_description' => $automation->name,
            'automation' => $automation,
            'canvasData' => [
                'id' => $automation->id,
                'name' => $automation->name,
                'description' => $automation->description,
                'status' => $automation->status,
                'version' => optional($automation->currentVersion)->version_number ?: 1,
                'creator_name' => optional($automation->creator)->name ?: (auth()->user()->name ?? 'User'),
                'created_at_fmt' => optional($automation->created_at)->format('d M Y h:i A') ?: '—',
                'updated_at_fmt' => optional($automation->updated_at)->format('d M Y h:i A') ?: '—',
                'runsUrl' => route('automations.runs.index', $automation),
                'approvalsUrl' => route('automations.approvals.index'),
                'graph' => $this->publisher->latestGraph($automation),
                'roles' => $roles->map(fn ($r) => ['id' => $r->id, 'name' => $r->name])->values()->all(),
                'timezones' => timezone_identifiers_list(),
                'backUrl' => route('automations.index'),
                'showUrl' => route('automations.show', $automation),
                'updateUrl' => route('automations.update', $automation),
                'saveGraphUrl' => route('automations.graph.save', $automation),
                'validateUrl' => route('automations.validate', $automation),
                'publishUrl' => route('automations.publish', $automation),
                'testRunUrl' => route('automations.test-run', $automation),
                'pauseUrl' => route('automations.pause', $automation),
                'resumeUrl' => route('automations.resume', $automation),
                'checklistListUrl' => route('checklists-list'),
                'usersListUrl' => route('users-list'),
                'assetsListUrl' => route('assets-list'),
                'storesListUrl' => route('stores-list'),
                'tasksListUrl' => route('automations.options.tasks'),
                'schedulingsListUrl' => route('automations.options.schedulings'),
                'zonesListUrl' => route('zones-list'),
                'documentsListUrl' => route('documents-list'),
                'departmentsListUrl' => route('departments-list'),
                'particularsListUrl' => route('particulars-list'),
                'issuesListUrl' => route('issues-list'),
                'notificationTemplateListUrl' => route('notification-template-list'),
                'uploadAttachmentUrl' => route('automations.attachments.upload', $automation),
                'webhookUrl' => $automation->webhook_token
                    ? url('/api/automations/webhook/'.$automation->webhook_token)
                    : null,
                'csrfToken' => csrf_token(),
                'method' => 'PUT',
            ],
        ];
    }

    /**
     * Select2-style paginated checklist tasks for condition value pickers.
     */
    public function tasksList(Request $request)
    {
        $search = trim((string) $request->get('searchQuery', ''));
        $page = max(1, (int) $request->get('page', 1));
        $limit = 15;

        $query = ChecklistTask::query()
            ->with(['parent.parent.checklist:id,name'])
            ->where('type', 0)
            ->latest('id');

        if ($search !== '') {
            $query->where(function ($q) use ($search) {
                $q->where('code', 'LIKE', "%{$search}%");
                if (is_numeric($search)) {
                    $q->orWhere('id', (int) $search);
                }
            });
        }

        $paginator = $query->paginate($limit, ['*'], 'page', $page);
        $items = $paginator->getCollection()->map(function (ChecklistTask $task) {
            $checklist = optional(optional(optional($task->parent)->parent)->checklist)->name;
            $label = trim(implode(' — ', array_filter([
                $task->code ? (string) $task->code : null,
                $checklist ? (string) $checklist : null,
                '#'.$task->id,
            ])));

            return ['id' => $task->id, 'text' => $label !== '' ? $label : ('Task #'.$task->id)];
        })->values();

        return response()->json([
            'items' => $items,
            'pagination' => ['more' => $paginator->hasMorePages()],
        ]);
    }

    /**
     * Select2-style paginated checklist schedulings for condition value pickers.
     */
    public function schedulingsList(Request $request)
    {
        $search = trim((string) $request->get('searchQuery', ''));
        $page = max(1, (int) $request->get('page', 1));
        $limit = 15;

        $query = ChecklistScheduling::query()
            ->with(['checklist:id,name'])
            ->latest('id');

        if ($search !== '') {
            $query->where(function ($q) use ($search) {
                if (is_numeric($search)) {
                    $q->orWhere('id', (int) $search);
                }
                $q->orWhereHas('checklist', function ($cq) use ($search) {
                    $cq->where('name', 'LIKE', "%{$search}%");
                });
            });
        }

        $paginator = $query->paginate($limit, ['*'], 'page', $page);
        $items = $paginator->getCollection()->map(function (ChecklistScheduling $row) {
            $name = optional($row->checklist)->name ?: 'Checklist';
            $when = $row->start ? (string) $row->start : '';

            return [
                'id' => $row->id,
                'text' => trim($name.($when ? ' — '.$when : '').' — #'.$row->id),
            ];
        })->values();

        return response()->json([
            'items' => $items,
            'pagination' => ['more' => $paginator->hasMorePages()],
        ]);
    }

    /**
     * Upload a file for notify-node email attachments (stored under public disk).
     */
    public function uploadAttachment(Request $request, Automation $automation)
    {
        $request->validate([
            'file' => 'required|file|max:10240',
        ]);

        $file = $request->file('file');
        $safeName = preg_replace('/[^A-Za-z0-9._-]+/', '_', $file->getClientOriginalName()) ?: 'attachment';
        $storedName = uniqid('att_', true).'_'.$safeName;
        $path = $file->storeAs(
            'automation-attachments/'.$automation->id,
            $storedName,
            'public'
        );

        return response()->json([
            'path' => $path,
            'name' => $file->getClientOriginalName(),
            'url' => asset('storage/'.$path),
        ]);
    }

    private function statusBadge(string $status): string
    {
        $map = [
            'draft' => 'secondary',
            'published' => 'success',
            'paused' => 'warning',
            'archived' => 'dark',
            'pending' => 'secondary',
            'approved' => 'success',
            'rejected' => 'danger',
            'expired' => 'dark',
        ];
        $class = $map[$status] ?? 'secondary';

        return '<span class="badge bg-'.$class.'">'.e(ucfirst($status)).'</span>';
    }

    private function runStatusBadge(string $status): string
    {
        $map = [
            'pending' => 'secondary',
            'running' => 'primary',
            'waiting' => 'warning',
            'completed' => 'success',
            'failed' => 'danger',
            'cancelled' => 'dark',
        ];
        $class = $map[$status] ?? 'secondary';

        return '<span class="badge bg-'.$class.'">'.e(ucfirst($status)).'</span>';
    }
}
