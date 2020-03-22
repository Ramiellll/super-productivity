import {Injectable} from '@angular/core';
import {Actions, Effect, ofType} from '@ngrx/effects';
import {select, Store} from '@ngrx/store';
import {concatMap, filter, first, map, switchMap, take, takeUntil, tap, withLatestFrom} from 'rxjs/operators';
import {PersistenceService} from '../../../../../core/persistence/persistence.service';
import {JiraApiService} from '../jira-api.service';
import {GlobalConfigService} from '../../../../config/global-config.service';
import {JiraIssueReduced} from './jira-issue.model';
import {SnackService} from '../../../../../core/snack/snack.service';
import {Task, TaskWithSubTasks} from '../../../../tasks/task.model';
import {TaskService} from '../../../../tasks/task.service';
import {forkJoin, Observable, timer} from 'rxjs';
import {MatDialog} from '@angular/material/dialog';
import {DialogJiraTransitionComponent} from '../jira-view-components/dialog-jira-transition/dialog-jira-transition.component';
import {IssueLocalState} from '../../../issue.model';
import {JIRA_INITIAL_POLL_BACKLOG_DELAY, JIRA_POLL_INTERVAL} from '../jira.const';
import {ProjectService} from '../../../../project/project.service';
import {IssueService} from '../../../issue.service';
import {JIRA_TYPE} from '../../../issue.const';
import {T} from '../../../../../t.const';
import {truncate} from '../../../../../util/truncate';
import {WorkContextService} from '../../../../work-context/work-context.service';
import {JiraCfg} from '../jira.model';
import {IssueEffectHelperService} from '../../../issue-effect-helper.service';
import {TaskActionTypes, UpdateTask} from '../../../../tasks/store/task.actions';
import {DialogJiraAddWorklogComponent} from '../jira-view-components/dialog-jira-add-worklog/dialog-jira-add-worklog.component';
import {selectTaskEntities} from '../../../../tasks/store/task.selectors';
import {Dictionary} from '@ngrx/entity';

@Injectable()
export class JiraIssueEffects {
  @Effect({dispatch: false})
  pollNewIssuesToBacklog$: any = this._issueEffectHelperService.pollToBacklogTriggerToProjectId$.pipe(
    switchMap((pId) => this._projectService.getJiraCfgForProject$(pId).pipe(
      first(),
      filter(jiraCfg => jiraCfg && jiraCfg.isEnabled && jiraCfg.isAutoAddToBacklog),
      // tap(() => console.log('POLL TIMER STARTED')),
      switchMap(jiraCfg => this._pollTimer$.pipe(
        // NOTE: required otherwise timer stays alive for filtered actions
        takeUntil(this._issueEffectHelperService.pollToBacklogActions$),
        tap(() => console.log('JIRA_POLL_BACKLOG_CHANGES')),
        tap(() => this._importNewIssuesToBacklog(pId, jiraCfg))
      )),
    )),
  );

  @Effect({dispatch: false})
  pollIssueChangesForCurrentContext$: any = this._issueEffectHelperService.pollIssueTaskUpdatesActions$.pipe(
    switchMap(() => this._pollTimer$),
    switchMap(() => this._workContextService.allTasksForCurrentContext$.pipe(
      first(),
      switchMap((tasks) => {
        const jiraIssueTasks = tasks.filter(task => task.issueType === JIRA_TYPE);
        return forkJoin(jiraIssueTasks.map(task =>
          this._projectService.getJiraCfgForProject$(task.projectId).pipe(
            first(),
            map(cfg => ({cfg, task}))
          ))
        );
      }),
      map((cos) => cos
        .filter(({cfg, task}: { cfg: JiraCfg, task: TaskWithSubTasks }) =>
          cfg.isEnabled && cfg.isAutoPollTickets
        )
        .map(({task}: { cfg: JiraCfg, task: TaskWithSubTasks }) => task)
      ),
      tap((jiraTasks: TaskWithSubTasks[]) => {
        if (jiraTasks && jiraTasks.length > 0) {
          this._snackService.open({
            msg: T.F.JIRA.S.POLLING,
            svgIco: 'jira',
            isSpinner: true,
          });
          jiraTasks.forEach((task) => this._issueService.refreshIssue(task, true, false));
        }
      }),
    )),
  );

  @Effect({dispatch: false})
  addWorklog$: any = this._actions$.pipe(
    ofType(TaskActionTypes.UpdateTask),
    filter((act: UpdateTask) => act.payload.task.changes.isDone === true),
    withLatestFrom(
      this._workContextService.isActiveWorkContextProject$,
      this._workContextService.activeWorkContextId$
    ),
    filter(([, isActiveContextProject]) => isActiveContextProject),
    concatMap(([act, , projectId]) => this._projectService.getJiraCfgForProject$(projectId).pipe(
      first(),
      map(jiraCfg => ({
        act,
        projectId,
        jiraCfg
      })),
    )),
    filter(({jiraCfg}) => jiraCfg.isEnabled),
    withLatestFrom(this._store$.pipe(select(selectTaskEntities))),
    tap(([{act, projectId, jiraCfg}, taskEntities]: [{
      act: UpdateTask,
      projectId: string,
      jiraCfg: JiraCfg
    }, Dictionary<Task>]) => {
      const taskId = act.payload.task.id;
      const task = taskEntities[taskId];

      if (jiraCfg.isWorklogEnabled
        && task && task.issueType === JIRA_TYPE
        && !(jiraCfg.isAddWorklogOnSubTaskDone && task.subTaskIds.length > 0)) {
        this._openWorklogDialog(task, task.issueId, jiraCfg);

      } else {
        const parent = task.parentId && taskEntities[task.parentId];
        if (parent && jiraCfg.isAddWorklogOnSubTaskDone && parent.issueType === JIRA_TYPE) {
          // NOTE we're still sending the sub task for the meta data we need
          this._openWorklogDialog(task, parent.issueId, jiraCfg);
        }
      }
    })
  );

  // @Effect({dispatch: false})
  // checkForReassignment: any = this._actions$
  //   .pipe(
  //     ofType(
  //       TaskActionTypes.SetCurrentTask,
  //     ),
  //     withLatestFrom(
  //       this._projectService.isJiraEnabled$,
  //       this._projectService.currentJiraCfg$,
  //       this._store$.pipe(select(selectCurrentTaskParentOrCurrent)),
  //     ),
  //     filter(([action, isEnabled, jiraCfg, currentTaskOrParent]) =>
  //       isEnabled
  //       && jiraCfg.isCheckToReAssignTicketOnTaskStart
  //       && currentTaskOrParent && currentTaskOrParent.issueType === JIRA_TYPE),
  //     // show every 15s max to give time for updates
  //     throttleTime(15000),
  //     // TODO there is probably a better way to to do this
  //     // TODO refactor to actions
  //     switchMap(([action, isEnabled, jiraCfg, currentTaskOrParent]) => {
  //       return this._jiraApiService.getReducedIssueById$(currentTaskOrParent.issueId).pipe(
  //         withLatestFrom(this._jiraApiService.getCurrentUser$()),
  //         concatMap(([issue, currentUser]) => {
  //           const assignee = issue.assignee;
  //
  //           if (!issue) {
  //             return throwError({[HANDLED_ERROR_PROP_STR]: 'Jira: Issue Data not found'});
  //           } else if (!issue.assignee || issue.assignee.accountId !== currentUser.accountId) {
  //             return this._matDialog.open(DialogConfirmComponent, {
  //               restoreFocus: true,
  //               data: {
  //                 okTxt: T.F.JIRA.DIALOG_CONFIRM_ASSIGNMENT.OK,
  //                 translateParams: {
  //                   summary: issue.summary,
  //                   assignee: assignee ? assignee.displayName : 'nobody'
  //                 },
  //                 message: T.F.JIRA.DIALOG_CONFIRM_ASSIGNMENT.MSG,
  //               }
  //             }).afterClosed()
  //               .pipe(
  //                 switchMap((isConfirm) => {
  //                   return isConfirm
  //                     ? this._jiraApiService.updateAssignee$(issue.id, currentUser.accountId)
  //                     : EMPTY;
  //                 }),
  //                 // tap(() => {
  //                 // TODO fix
  //                 // this._jiraIssueService.updateIssueFromApi(issue.id, issue, false, false);
  //                 // }),
  //               );
  //           } else {
  //             return EMPTY;
  //           }
  //         })
  //       );
  //     })
  //   );

  // @Effect({dispatch: false})
  // checkForStartTransition$: Observable<any> = this._actions$
  //   .pipe(
  //     ofType(
  //       TaskActionTypes.SetCurrentTask,
  //     ),
  //     withLatestFrom(
  //       this._projectService.isJiraEnabled$,
  //       this._projectService.currentJiraCfg$,
  //       this._store$.pipe(select(selectCurrentTaskParentOrCurrent)),
  //     ),
  //     filter(([action, isEnabled]) => isEnabled),
  //     filter(([action, isEnabled, jiraCfg, curOrParTask]) =>
  //       jiraCfg && jiraCfg.isTransitionIssuesEnabled && curOrParTask && curOrParTask.issueType === JIRA_TYPE),
  //     concatMap(([action, isEnabled, jiraCfg, curOrParTask]) =>
  //       this._handleTransitionForIssue(IssueLocalState.IN_PROGRESS, jiraCfg, curOrParTask)
  //     ),
  //   );

  // @Effect({dispatch: false})
  // checkForDoneTransition$: Observable<any> = this._actions$
  //   .pipe(
  //     ofType(
  //       TaskActionTypes.UpdateTask,
  //     ),
  //     // only trigger when changing to done
  //     filter((a: UpdateTask) => a.payload.task.changes.isDone),
  //     withLatestFrom(
  //       this._projectService.isJiraEnabled$,
  //       this._projectService.currentJiraCfg$,
  //       this._store$.pipe(select(selectTaskFeatureState)),
  //     ),
  //     filter(([a, isEnabled]) => isEnabled),
  //     filter(([a, isEnabled, jiraCfg, taskState]: [UpdateTask, boolean, JiraCfg, TaskState]) => {
  //       const task = taskState.entities[a.payload.task.id];
  //       return jiraCfg && jiraCfg.isTransitionIssuesEnabled && task && task.issueType === JIRA_TYPE && task.isDone;
  //     }),
  //     concatMap(([a, isEnabled, jiraCfg, taskState]: [UpdateTask, boolean, JiraCfg, TaskState]) => {
  //       const task = taskState.entities[a.payload.task.id];
  //       return this._handleTransitionForIssue(IssueLocalState.DONE, jiraCfg, task);
  //     })
  //   );


  private _pollTimer$: Observable<number> = timer(JIRA_INITIAL_POLL_BACKLOG_DELAY, JIRA_POLL_INTERVAL);

  constructor(private readonly _actions$: Actions,
              private readonly _store$: Store<any>,
              private readonly _configService: GlobalConfigService,
              private readonly _snackService: SnackService,
              private readonly _projectService: ProjectService,
              private readonly _taskService: TaskService,
              private readonly _workContextService: WorkContextService,
              private readonly _jiraApiService: JiraApiService,
              private readonly _issueService: IssueService,
              private readonly _persistenceService: PersistenceService,
              private readonly _matDialog: MatDialog,
              private readonly _issueEffectHelperService: IssueEffectHelperService,
  ) {
  }

  // private _handleTransitionForIssue(localState: IssueLocalState, jiraCfg: JiraCfg, task: Task): Observable<any> {
  //   const chosenTransition: JiraTransitionOption = jiraCfg.transitionConfig[localState];
  //
  //   switch (chosenTransition) {
  //     case 'DO_NOT':
  //       return EMPTY;
  //     case 'ALWAYS_ASK':
  //       return this._jiraApiService.getReducedIssueById$(task.issueId).pipe(
  //         concatMap((issue) => this._openTransitionDialog(issue, localState, task)
  //         )
  //       );
  //     default:
  //       if (!chosenTransition || !chosenTransition.id) {
  //         this._snackService.open({
  //           msg: T.F.JIRA.S.NO_VALID_TRANSITION,
  //           type: 'ERROR',
  //         });
  //         // NOTE: we would kill the whole effect chain if we do this
  //         // return throwError({[HANDLED_ERROR_PROP_STR]: 'Jira: No valid transition configured'});
  //         return timer(2000).pipe(
  //           concatMap(() => this._jiraApiService.getReducedIssueById$(task.issueId)),
  //           concatMap((issue: JiraIssue) => this._openTransitionDialog(issue, localState, task))
  //         );
  //       }
  //
  //       return this._jiraApiService.getReducedIssueById$(task.issueId).pipe(
  //         concatMap((issue) => {
  //           if (!issue.status || issue.status.name !== chosenTransition.name) {
  //             return this._jiraApiService.transitionIssue$(issue.id, chosenTransition.id)
  //               .pipe(
  //                 tap(() => {
  //                   this._snackService.open({
  //                     type: 'SUCCESS',
  //                     msg: T.F.JIRA.S.TRANSITION_SUCCESS,
  //                     translateParams: {
  //                       issueKey: `${issue.key}`,
  //                       chosenTransition: `${chosenTransition.name}`,
  //                     },
  //                   });
  //                   this._issueService.refreshIssue(task, false, false);
  //                 })
  //               );
  //           } else {
  //             // no transition required
  //             return EMPTY;
  //           }
  //         })
  //       );
  //   }
  // }
  //
  private _openWorklogDialog(task: Task, issueId: string, jiraCfg: JiraCfg) {
    return this._jiraApiService.getReducedIssueById$(issueId, jiraCfg).pipe(take(1)).subscribe(issue => {
      this._matDialog.open(DialogJiraAddWorklogComponent, {
        restoreFocus: true,
        data: {
          issue,
          task,
        }
      });
    });
  }

  private _openTransitionDialog(issue: JiraIssueReduced, localState: IssueLocalState, task: Task): Observable<any> {
    return this._matDialog.open(DialogJiraTransitionComponent, {
      restoreFocus: true,
      data: {
        issue,
        localState,
        task,
      }
    }).afterClosed();
  }

  private _importNewIssuesToBacklog(projectId: string, cfg: JiraCfg) {
    this._jiraApiService.findAutoImportIssues$(cfg).subscribe(async (issues: JiraIssueReduced[]) => {

      if (!Array.isArray(issues)) {
        return;
      }
      const allTaskJiraIssueIds = await this._taskService.getAllIssueIdsForCurrentProject(JIRA_TYPE) as string[];


      // NOTE: we check for key as well as id although normally the key should suffice
      const issuesToAdd = issues.filter(
        issue => !allTaskJiraIssueIds.includes(issue.id) && !allTaskJiraIssueIds.includes(issue.key)
      );

      issuesToAdd.forEach((issue) => {
        this._issueService.addTaskWithIssue(JIRA_TYPE, issue, projectId, true);
      });

      if (issuesToAdd.length === 1) {
        this._snackService.open({
          translateParams: {
            issueText: truncate(`${issuesToAdd[0].key} ${issuesToAdd[0].summary}`),
          },
          msg: T.F.JIRA.S.IMPORTED_SINGLE_ISSUE,
          ico: 'cloud_download',
        });
      } else if (issuesToAdd.length > 1) {
        this._snackService.open({
          translateParams: {
            issuesLength: issuesToAdd.length
          },
          msg: T.F.JIRA.S.IMPORTED_MULTIPLE_ISSUES,
          ico: 'cloud_download',
        });
      }
    });
  }
}

