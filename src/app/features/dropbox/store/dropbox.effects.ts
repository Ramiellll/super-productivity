import { Injectable } from '@angular/core';
import { Actions, Effect, ofType } from '@ngrx/effects';
import { GlobalConfigActionTypes, UpdateGlobalConfigSection } from '../../config/store/global-config.actions';
import { catchError, filter, map, pairwise, shareReplay, switchMap, tap, withLatestFrom } from 'rxjs/operators';
import { DropboxApiService } from '../dropbox-api.service';
import { DataInitService } from '../../../core/data-init/data-init.service';
import { EMPTY, from, Observable } from 'rxjs';
import { SnackService } from '../../../core/snack/snack.service';
import { T } from '../../../t.const';

@Injectable()
export class DropboxEffects {
  private _isChangedAuthCode$: Observable<boolean> = this._dataInitService.isAllDataLoadedInitially$.pipe(
    // NOTE: it is important that we don't use distinct until changed here
    switchMap(() => this._dropboxApiService.authCode$),
    pairwise(),
    map(([a, b]) => a !== b),
    shareReplay(),
  );

  @Effect() generateAccessCode$: any = this._actions$.pipe(
    ofType(
      GlobalConfigActionTypes.UpdateGlobalConfigSection,
    ),
    filter(({payload}: UpdateGlobalConfigSection): boolean =>
      payload.sectionKey === 'dropboxSync'
      && (payload.sectionCfg as any).authCode),
    withLatestFrom(this._isChangedAuthCode$),
    filter(([, isChanged]: [any, boolean]): boolean => isChanged),
    switchMap(([{payload}, isChanged]: [UpdateGlobalConfigSection, boolean]) =>
      from(this._dropboxApiService.getAccessTokenFromAuthCode((payload.sectionCfg as any).authCode)).pipe(
        // NOTE: catch needs to be limited to request only, otherwise we break the chain
        catchError((e) => {
          console.error(e);
          this._snackService.open({type: 'ERROR', msg: T.F.DROPBOX.S.ACCESS_TOKEN_ERROR});
          // filter
          return EMPTY;
        }),
      )
    ),
    tap(() => setTimeout(() => this._snackService.open({
        type: 'SUCCESS',
        msg: T.F.DROPBOX.S.ACCESS_TOKEN_GENERATED
      }), 200)
    ),
    map((accessToken: string) => new UpdateGlobalConfigSection({
      sectionKey: 'dropboxSync',
      sectionCfg: {accessToken}
    })),
  );

  constructor(
    private _actions$: Actions,
    private _dropboxApiService: DropboxApiService,
    private _snackService: SnackService,
    private _dataInitService: DataInitService,
  ) {
  }
}
