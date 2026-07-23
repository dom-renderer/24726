<?php

namespace App\Services\Automation;

use App\Models\Automation;
use App\Models\AutomationNode;
use App\Models\AutomationSchedule;
use App\Models\AutomationVersion;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Owns the lifecycle of automation graphs: normalising authoring payloads,
 * persisting drafts, and publishing immutable, materialised versions.
 *
 * A "version" is a snapshot of the graph. While `published_at` is null it is a
 * mutable draft; publishing stamps it immutable, materialises node/edge rows,
 * points the automation at it, and syncs the schedule / webhook credentials.
 */
class AutomationPublisher
{
    public function __construct(
        private readonly AutomationGraphValidator $validator,
        private readonly ScheduleCalculator $scheduleCalculator,
    ) {
    }

    /**
     * Convert any authoring payload into the canonical graph shape used
     * everywhere at runtime: {nodes:[{key,type,subtype,name,config,position}],
     * edges:[{key,source,target,branch}]}.
     */
    public function normalizeGraph(array $graph): array
    {
        $nodes = [];
        foreach (($graph['nodes'] ?? []) as $node) {
            $node = (array) $node;
            $key = (string) ($node['key'] ?? $node['id'] ?? $node['node_key'] ?? Str::uuid());

            $nodes[] = [
                'key' => $key,
                'id' => $key, // canvas editor compatibility
                'type' => (string) ($node['type'] ?? ''),
                'subtype' => (string) ($node['subtype'] ?? ''),
                'name' => (string) ($node['name'] ?? $key),
                'subtitle' => isset($node['subtitle']) ? (string) $node['subtitle'] : null,
                'theme' => isset($node['theme']) ? (string) $node['theme'] : null,
                'config' => (array) ($node['config'] ?? $node['config_json'] ?? []),
                'x' => (int) ($node['x'] ?? $node['position']['x'] ?? $node['position_x'] ?? 0),
                'y' => (int) ($node['y'] ?? $node['position']['y'] ?? $node['position_y'] ?? 0),
                'position' => [
                    'x' => (int) ($node['x'] ?? $node['position']['x'] ?? $node['position_x'] ?? 0),
                    'y' => (int) ($node['y'] ?? $node['position']['y'] ?? $node['position_y'] ?? 0),
                ],
            ];
        }

        $edges = [];
        foreach (($graph['edges'] ?? []) as $i => $edge) {
            $edge = (array) $edge;
            $branch = $edge['branch'] ?? $edge['branchKey'] ?? $edge['branch_key'] ?? null;
            $edgeKey = (string) ($edge['key'] ?? $edge['id'] ?? $edge['edge_key'] ?? ('e' . ($i + 1) . '_' . Str::random(6)));

            $edges[] = [
                'key' => $edgeKey,
                'id' => $edgeKey,
                'source' => (string) ($edge['source'] ?? $edge['source_node_key'] ?? ''),
                'target' => (string) ($edge['target'] ?? $edge['target_node_key'] ?? ''),
                'branch' => ($branch === null || $branch === '') ? null : (string) $branch,
                'branchKey' => ($branch === null || $branch === '') ? null : (string) $branch,
                'dashed' => !empty($edge['dashed']),
            ];
        }

        return ['nodes' => $nodes, 'edges' => $edges];
    }

    /**
     * Persist the working draft graph for an automation. Drafts are permitted
     * to be incomplete, so this does not enforce full validation.
     */
    public function saveDraft(Automation $automation, array $graph, ?string $changelog = null, ?int $userId = null): AutomationVersion
    {
        $normalized = $this->normalizeGraph($graph);

        $draft = $this->currentDraft($automation) ?? $this->newDraftModel($automation);
        $draft->graph_json = $normalized;
        if ($changelog !== null) {
            $draft->changelog = $changelog;
        }
        $draft->save();

        if ($userId !== null) {
            $automation->forceFill(['updated_by' => $userId])->save();
        }

        return $draft->refresh();
    }

    /**
     * Publish a graph as a new immutable version and make it the live version.
     *
     * @param array|null $graph When null the current draft (or latest) graph is used.
     */
    public function publish(Automation $automation, ?array $graph = null, ?int $publishedBy = null, ?string $changelog = null): AutomationVersion
    {
        $normalized = $this->normalizeGraph($graph ?? $this->latestGraph($automation));
        $this->validator->assertValid($normalized);

        return DB::transaction(function () use ($automation, $normalized, $publishedBy, $changelog) {
            $version = $this->currentDraft($automation) ?? $this->newDraftModel($automation);
            $version->graph_json = $normalized;
            $version->published_at = now();
            $version->published_by = $publishedBy;
            if ($changelog !== null) {
                $version->changelog = $changelog;
            }
            $version->save();

            $this->materializeNodesAndEdges($version, $normalized);

            $automation->forceFill([
                'current_version_id' => $version->id,
                'status' => Automation::STATUS_PUBLISHED,
                'updated_by' => $publishedBy,
            ]);
            $this->ensureWebhookCredentials($automation, $normalized);
            $automation->save();

            $this->syncScheduleFromGraph($automation, $version, $normalized);

            return $version->refresh();
        });
    }

    /**
     * Materialise the graph into automation_nodes / automation_edges rows for
     * fast querying and referential integrity. Idempotent per version.
     */
    public function materializeNodesAndEdges(AutomationVersion $version, array $graph): void
    {
        $version->nodes()->delete();
        $version->edges()->delete();

        foreach ($graph['nodes'] as $node) {
            AutomationNode::create([
                'automation_version_id' => $version->id,
                'node_key' => $node['key'],
                'type' => $node['type'],
                'subtype' => $node['subtype'],
                'name' => $node['name'],
                'config_json' => $node['config'],
                'position_x' => $node['position']['x'] ?? 0,
                'position_y' => $node['position']['y'] ?? 0,
            ]);
        }

        foreach ($graph['edges'] as $edge) {
            \App\Models\AutomationEdge::create([
                'automation_version_id' => $version->id,
                'edge_key' => $edge['key'],
                'source_node_key' => $edge['source'],
                'target_node_key' => $edge['target'],
                'branch_key' => $edge['branch'],
            ]);
        }
    }

    /**
     * Create or update the active schedule based on the graph's schedule
     * trigger. When there is no schedule trigger, existing schedules are
     * deactivated.
     */
    public function syncScheduleFromGraph(Automation $automation, AutomationVersion $version, array $graph): void
    {
        $trigger = $this->findTrigger($graph, AutomationNode::SUBTYPE_SCHEDULE);

        if ($trigger === null) {
            $automation->schedules()->update(['is_active' => false]);

            return;
        }

        $config = $trigger['config'] ?? [];
        $frequency = (string) ($config['frequency'] ?? ScheduleCalculator::FREQ_DAILY);
        $timezone = (string) ($config['timezone'] ?? ScheduleCalculator::DEFAULT_TIMEZONE);
        $timeOfDay = $config['time_of_day'] ?? $config['time'] ?? null;
        $cron = $config['cron_expression'] ?? $config['cron'] ?? null;

        // Only one active schedule per automation.
        $automation->schedules()->update(['is_active' => false]);

        $schedule = $automation->schedules()->firstOrNew([
            'automation_version_id' => $version->id,
        ]);

        $schedule->fill([
            'automation_version_id' => $version->id,
            'frequency' => $frequency,
            'cron_expression' => $cron,
            'time_of_day' => $timeOfDay,
            'timezone' => $timezone,
            'is_active' => true,
        ]);
        $schedule->save();

        $schedule->next_run_at = $this->scheduleCalculator->nextRunAt($schedule);
        $schedule->save();
    }

    /**
     * Generate webhook credentials the first time a webhook-triggered graph is
     * published. Existing credentials are preserved so integrations keep working.
     */
    public function ensureWebhookCredentials(Automation $automation, array $graph): void
    {
        $trigger = $this->findTrigger($graph, AutomationNode::SUBTYPE_WEBHOOK);

        if ($trigger === null) {
            return;
        }

        if (empty($automation->webhook_token)) {
            $automation->webhook_token = Str::random(48);
        }

        if (empty($automation->webhook_secret)) {
            $automation->webhook_secret = Str::random(64);
        }
    }

    /**
     * The graph the editor should load: live version, else current draft, else
     * a sensible starter graph.
     */
    public function latestGraph(Automation $automation): array
    {
        if ($automation->current_version_id) {
            $current = $automation->currentVersion()->first();
            if ($current && is_array($current->graph_json)) {
                return $this->normalizeGraph($current->graph_json);
            }
        }

        $draft = $this->currentDraft($automation);
        if ($draft && is_array($draft->graph_json)) {
            return $this->normalizeGraph($draft->graph_json);
        }

        return $this->emptyStarterGraph();
    }

    /**
     * A ready-to-edit starter graph: schedule → assign_checklist → notify → end.
     */
    public function emptyStarterGraph(): array
    {
        return [
            'nodes' => [
                [
                    'key' => 'trigger',
                    'type' => AutomationNode::TYPE_TRIGGER,
                    'subtype' => AutomationNode::SUBTYPE_SCHEDULE,
                    'name' => 'Daily schedule',
                    'config' => [
                        'frequency' => ScheduleCalculator::FREQ_DAILY,
                        'time_of_day' => '09:00',
                        'timezone' => ScheduleCalculator::DEFAULT_TIMEZONE,
                    ],
                    'position' => ['x' => 80, 'y' => 160],
                ],
                [
                    'key' => 'assign',
                    'type' => AutomationNode::TYPE_ACTION,
                    'subtype' => AutomationNode::SUBTYPE_ASSIGN_CHECKLIST,
                    'name' => 'Assign checklist',
                    'config' => [
                        'checklist_id' => null,
                        'assignment_type' => 1,
                        'role_ids' => [],
                        'user_ids' => [],
                        'due_in' => ['value' => 1, 'unit' => 'days'],
                    ],
                    'position' => ['x' => 360, 'y' => 160],
                ],
                [
                    'key' => 'notify',
                    'type' => AutomationNode::TYPE_ACTION,
                    'subtype' => AutomationNode::SUBTYPE_NOTIFY,
                    'name' => 'Notify assignees',
                    'config' => [
                        'channel' => 'both',
                        'content_mode' => 'custom',
                        'subject' => 'New checklist assigned',
                        'body' => 'A checklist has been assigned to you.',
                        'title' => 'New checklist assigned',
                        'message' => 'A checklist has been assigned to you.',
                        'recipients_path' => 'assign.assigned_user_ids',
                        'attachments' => [],
                    ],
                    'position' => ['x' => 640, 'y' => 160],
                ],
                [
                    'key' => 'end',
                    'type' => AutomationNode::TYPE_FLOW,
                    'subtype' => AutomationNode::SUBTYPE_END,
                    'name' => 'End',
                    'config' => [],
                    'position' => ['x' => 920, 'y' => 160],
                ],
            ],
            'edges' => [
                ['key' => 'e1', 'source' => 'trigger', 'target' => 'assign', 'branch' => null],
                ['key' => 'e2', 'source' => 'assign', 'target' => 'notify', 'branch' => null],
                ['key' => 'e3', 'source' => 'notify', 'target' => 'end', 'branch' => null],
            ],
        ];
    }

    /**
     * The latest unpublished (draft) version, if any.
     */
    public function currentDraft(Automation $automation): ?AutomationVersion
    {
        return $automation->versions()
            ->whereNull('published_at')
            ->orderByDesc('version_number')
            ->first();
    }

    private function newDraftModel(Automation $automation): AutomationVersion
    {
        $next = (int) $automation->versions()->max('version_number') + 1;

        $draft = new AutomationVersion();
        $draft->automation_id = $automation->id;
        $draft->version_number = $next;
        $draft->graph_json = ['nodes' => [], 'edges' => []];

        return $draft;
    }

    /**
     * @return array|null normalized trigger node of the given subtype
     */
    private function findTrigger(array $graph, string $subtype): ?array
    {
        foreach (($graph['nodes'] ?? []) as $node) {
            if (($node['type'] ?? null) === AutomationNode::TYPE_TRIGGER
                && ($node['subtype'] ?? null) === $subtype) {
                return $node;
            }
        }

        return null;
    }
}
