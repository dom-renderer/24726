<?php

namespace Database\Seeders;

use App\Models\Automation;
use App\Models\AutomationNode;
use App\Models\AutomationVersion;
use App\Models\User;
use App\Services\Automation\AutomationPublisher;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class VehicleInspectionAutomationSeeder extends Seeder
{
    public function run(): void
    {
        /** @var AutomationPublisher $publisher */
        $publisher = app(AutomationPublisher::class);

        $adminUser = User::query()->first();
        $userId = $adminUser ? $adminUser->id : null;

        $automation = Automation::withTrashed()->find(1);

        if (!$automation) {
            $automation = new Automation();
            $automation->id = 1;
        } elseif ($automation->trashed()) {
            $automation->restore();
        }

        $automation->name = 'Vehicle Inspection & Maintenance Workflow';
        $automation->description = 'Automated vehicle inspection, checklist assignment, score validation, and maintenance ticketing workflow.';
        $automation->status = Automation::STATUS_PUBLISHED;
        $automation->created_by = $automation->created_by ?: $userId;
        $automation->updated_by = $userId;
        $automation->save();

        $graph = [
            'nodes' => [
                [
                    'key' => 'n_1',
                    'id' => 'n_1',
                    'type' => 'trigger',
                    'subtype' => 'schedule',
                    'name' => 'Schedule Trigger',
                    'subtitle' => "Every day at 08:00 AM",
                    'config' => [
                        'frequency' => 'daily',
                        'time' => '08:00',
                        'timezone' => 'UTC',
                    ],
                    'position' => ['x' => 350, 'y' => 20],
                    'x' => 350,
                    'y' => 20,
                ],
                [
                    'key' => 'n_2',
                    'id' => 'n_2',
                    'type' => 'flow',
                    'subtype' => 'parallel',
                    'name' => 'For Each Asset',
                    'subtitle' => "Asset Type: Vehicle\nLocation: All",
                    'config' => [
                        'asset_type' => 'Vehicle',
                        'location' => 'All',
                    ],
                    'position' => ['x' => 350, 'y' => 135],
                    'x' => 350,
                    'y' => 135,
                ],
                [
                    'key' => 'n_3',
                    'id' => 'n_3',
                    'type' => 'action',
                    'subtype' => 'assign_checklist',
                    'name' => 'Assign Checklist',
                    'subtitle' => "Checklist: Daily Vehicle Inspection\nAssign to: Asset Owner",
                    'config' => [
                        'checklist_name' => 'Daily Vehicle Inspection',
                        'assign_to' => 'Asset Owner',
                        'asset_source' => 'Current Asset',
                        'due_date' => 'Today',
                        'allow_reassign' => true,
                    ],
                    'position' => ['x' => 350, 'y' => 250],
                    'x' => 350,
                    'y' => 250,
                ],
                [
                    'key' => 'n_4',
                    'id' => 'n_4',
                    'type' => 'condition',
                    'subtype' => 'if_else',
                    'name' => 'Checklist Submitted?',
                    'subtitle' => "Wait up to 4 hours",
                    'theme' => 'yellow',
                    'config' => [
                        'wait_hours' => 4,
                    ],
                    'position' => ['x' => 350, 'y' => 370],
                    'x' => 350,
                    'y' => 370,
                ],
                [
                    'key' => 'n_5',
                    'id' => 'n_5',
                    'type' => 'action',
                    'subtype' => 'notify',
                    'name' => 'Reminder',
                    'subtitle' => "Send reminder to user\nEvery 30 minutes",
                    'config' => [
                        'interval' => '30 minutes',
                        'target' => 'user',
                    ],
                    'position' => ['x' => 130, 'y' => 490],
                    'x' => 130,
                    'y' => 490,
                ],
                [
                    'key' => 'n_6',
                    'id' => 'n_6',
                    'type' => 'condition',
                    'subtype' => 'if_else',
                    'name' => 'Submitted after 4 hours?',
                    'subtitle' => '',
                    'theme' => 'red',
                    'config' => [
                        'timeout_hours' => 4,
                    ],
                    'position' => ['x' => 130, 'y' => 620],
                    'x' => 130,
                    'y' => 620,
                ],
                [
                    'key' => 'n_7',
                    'id' => 'n_7',
                    'type' => 'action',
                    'subtype' => 'notify',
                    'name' => 'Escalate',
                    'subtitle' => "Notify Supervisor\nand Asset Owner",
                    'config' => [
                        'recipients' => ['Supervisor', 'Asset Owner'],
                    ],
                    'position' => ['x' => -20, 'y' => 750],
                    'x' => -20,
                    'y' => 750,
                ],
                [
                    'key' => 'n_8',
                    'id' => 'n_8',
                    'type' => 'action',
                    'subtype' => 'create_ticket',
                    'name' => 'Create Ticket',
                    'subtitle' => "Type: Missed Inspection\nPriority: High",
                    'config' => [
                        'ticket_type' => 'Missed Inspection',
                        'priority' => 'High',
                    ],
                    'position' => ['x' => 220, 'y' => 750],
                    'x' => 220,
                    'y' => 750,
                ],
                [
                    'key' => 'n_9',
                    'id' => 'n_9',
                    'type' => 'condition',
                    'subtype' => 'wait_until',
                    'name' => 'Inspection Score ≥ 80?',
                    'subtitle' => '',
                    'theme' => 'blue',
                    'config' => [
                        'min_score' => 80,
                    ],
                    'position' => ['x' => 600, 'y' => 490],
                    'x' => 600,
                    'y' => 490,
                ],
                [
                    'key' => 'n_10',
                    'id' => 'n_10',
                    'type' => 'action',
                    'subtype' => 'asset',
                    'name' => 'Update Asset Status',
                    'subtitle' => "Status: Inspection Passed\nNext Inspection in 24 hrs",
                    'config' => [
                        'status' => 'Inspection Passed',
                        'next_inspection' => '24 hrs',
                    ],
                    'position' => ['x' => 810, 'y' => 580],
                    'x' => 810,
                    'y' => 580,
                ],
                [
                    'key' => 'n_11',
                    'id' => 'n_11',
                    'type' => 'action',
                    'subtype' => 'notify',
                    'name' => 'Complete Workflow',
                    'subtitle' => "Mark as completed\nSend success notification",
                    'config' => [
                        'action' => 'complete',
                        'notify' => true,
                    ],
                    'position' => ['x' => 810, 'y' => 710],
                    'x' => 810,
                    'y' => 710,
                ],
                [
                    'key' => 'n_12',
                    'id' => 'n_12',
                    'type' => 'action',
                    'subtype' => 'create_ticket',
                    'name' => 'Create Ticket',
                    'subtitle' => "Type: Inspection Failed\nPriority: High",
                    'config' => [
                        'ticket_type' => 'Inspection Failed',
                        'priority' => 'High',
                    ],
                    'position' => ['x' => 540, 'y' => 620],
                    'x' => 540,
                    'y' => 620,
                ],
                [
                    'key' => 'n_13',
                    'id' => 'n_13',
                    'type' => 'action',
                    'subtype' => 'notify',
                    'name' => 'Notify Users',
                    'subtitle' => "Notify Maintenance Team\nand Supervisor",
                    'config' => [
                        'recipients' => ['Maintenance Team', 'Supervisor'],
                    ],
                    'position' => ['x' => 540, 'y' => 735],
                    'x' => 540,
                    'y' => 735,
                ],
                [
                    'key' => 'n_14',
                    'id' => 'n_14',
                    'type' => 'flow',
                    'subtype' => 'wait',
                    'name' => 'Wait',
                    'subtitle' => "Until ticket is resolved\nCheck every 2 hours",
                    'config' => [
                        'condition' => 'ticket_resolved',
                        'check_interval' => '2 hours',
                    ],
                    'position' => ['x' => 540, 'y' => 850],
                    'x' => 540,
                    'y' => 850,
                ],
            ],
            'edges' => [
                ['key' => 'e_1', 'source' => 'n_1', 'target' => 'n_2', 'branch' => null, 'branchKey' => null],
                ['key' => 'e_2', 'source' => 'n_2', 'target' => 'n_3', 'branch' => null, 'branchKey' => null],
                ['key' => 'e_3', 'source' => 'n_3', 'target' => 'n_4', 'branch' => null, 'branchKey' => null],
                ['key' => 'e_4', 'source' => 'n_4', 'target' => 'n_5', 'branch' => 'false', 'branchKey' => 'false'],
                ['key' => 'e_5', 'source' => 'n_4', 'target' => 'n_9', 'branch' => 'true', 'branchKey' => 'true'],
                ['key' => 'e_6', 'source' => 'n_5', 'target' => 'n_6', 'branch' => null, 'branchKey' => null],
                ['key' => 'e_7', 'source' => 'n_6', 'target' => 'n_7', 'branch' => 'false', 'branchKey' => 'false'],
                ['key' => 'e_8', 'source' => 'n_6', 'target' => 'n_8', 'branch' => 'true', 'branchKey' => 'true'],
                ['key' => 'e_9', 'source' => 'n_9', 'target' => 'n_10', 'branch' => 'true', 'branchKey' => 'true'],
                ['key' => 'e_10', 'source' => 'n_9', 'target' => 'n_12', 'branch' => 'false', 'branchKey' => 'false'],
                ['key' => 'e_11', 'source' => 'n_10', 'target' => 'n_11', 'branch' => null, 'branchKey' => null],
                ['key' => 'e_12', 'source' => 'n_12', 'target' => 'n_13', 'branch' => null, 'branchKey' => null],
                ['key' => 'e_13', 'source' => 'n_13', 'target' => 'n_14', 'branch' => null, 'branchKey' => null],
                ['key' => 'e_14', 'source' => 'n_14', 'target' => 'n_11', 'branch' => null, 'branchKey' => null, 'dashed' => true],
                ['key' => 'e_15', 'source' => 'n_8', 'target' => 'n_14', 'branch' => null, 'branchKey' => null, 'dashed' => true],
            ],
        ];

        // Create Version 3
        $versionNumber = 3;
        $version = AutomationVersion::query()
            ->where('automation_id', $automation->id)
            ->where('version_number', $versionNumber)
            ->first();

        if (!$version) {
            $version = new AutomationVersion();
            $version->automation_id = $automation->id;
            $version->version_number = $versionNumber;
        }

        $version->graph_json = $publisher->normalizeGraph($graph);
        $version->published_at = now();
        $version->published_by = $userId;
        $version->changelog = 'Published initial ditto-to-ditto Vehicle Inspection & Maintenance Workflow';
        $version->save();

        $publisher->materializeNodesAndEdges($version, $publisher->normalizeGraph($graph));

        $automation->current_version_id = $version->id;
        $automation->status = Automation::STATUS_PUBLISHED;
        $automation->save();

        $publisher->syncScheduleFromGraph($automation, $version, $publisher->normalizeGraph($graph));
    }
}
