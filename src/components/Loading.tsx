import React, { useEffect, useRef, useState, FunctionComponent } from 'react';
import { View, StyleSheet } from 'react-native';
import { connect } from 'react-redux';
import { CardStyleInterpolators, createStackNavigator } from '@react-navigation/stack';
import AsyncStorage from '@react-native-community/async-storage';
import moment from 'moment';
import BackgroundFetch from 'react-native-background-fetch';
import BackgroundGeolocation, { State } from 'react-native-background-geolocation';
import OnboardingRoutes from './Onboarding/OnboardingRoutes';
import Home from './Drawer/Home';
import ChangeLanguage from './ChangeLanguage/ChangeLanguageModal';
import { Loader, GeneralWebview, ForceUpdate, ForceTerms } from './common';
import { initLocale } from '../actions/LocaleActions';
import { checkForceUpdate, toggleWebview } from '../actions/GeneralActions';
import { setExposures } from '../actions/ExposuresActions';
import { scheduleTask } from '../services/BackgroundService';
import { onError } from '../services/ErrorService';
import { purgeSamplesDB, startSampling } from '../services/SampleService';
import { updateLocationsTimesToUTC } from '../services/LocationService';
import { startForegroundTimer } from '../services/Tracker';
import { clusterLocationsOnAppUpdate } from '../services/ClusteringService';
import { initBLETracing, registerBLEListeners } from '../services/BLEService';
import { IntersectionSickDatabase } from '../database/Database';
import { initConfig } from '../config/config';
import store from '../store';
import { ExternalUrls, NotificationData, Strings } from '../locale/LocaleData';
import { ValidExposure } from '../types';
import {
  SET_VALID_EXPOSURE,
  RESET_EXPOSURES,
  UPDATE_FIRST_POINT,
  HIDE_FORCE_TERMS,
  SHOW_FORCE_TERMS
} from '../constants/ActionTypes';
import {
  CURRENT_TERMS_VERSION,
  FIRST_POINT_TS,
  IS_FIRST_TIME,
  IS_IOS,
  USAGE_ON_BOARDING,
  VALID_EXPOSURE,
  DISMISSED_EXPOSURES,
  SICK_DB_UPDATED,
  VERSION_NAME
} from '../constants/Constants';


interface Props {
  isInitLocale: boolean,
  isRTL: boolean,
  strings: Strings,
  locale: string,
  externalUrls: ExternalUrls,
  notificationData: NotificationData,
  showLoader: boolean,
  showWebview: boolean,
  showForceUpdate: boolean,
  shouldForce: boolean,
  showChangeLanguage: boolean,
  usageType: string,
  showForceTerms: boolean,
  termsVersion: number,
  initLocale(): void,
  toggleWebview(isShow: boolean, usageType: string): void,
  checkForceUpdate(): void
}

const Loading: FunctionComponent<Props> = (
  {
    isInitLocale,
    isRTL,
    showLoader,
    showChangeLanguage,
    strings,
    locale,
    externalUrls,
    notificationData,
    initLocale,
    showWebview,
    usageType,
    toggleWebview,
    showForceUpdate,
    shouldForce,
    showForceTerms,
    checkForceUpdate,
    termsVersion
  }
) => {
  const shouldShowForceTerms = useRef(false);

  const [initialRoute, setInitialRoute] = useState('');

  useEffect(() => {
    registerBLEListeners();
    appLoadingActions();
  }, []);

  useEffect(() => {
    if (!showWebview && shouldShowForceTerms.current) {
      store().dispatch({ type: SHOW_FORCE_TERMS, payload: { terms: termsVersion } });
      shouldShowForceTerms.current = false;
    }
  }, [showWebview]);

  const appLoadingActions = async () => {
    try {
      await updateLocationsTimesToUTC();
      await initConfig();
      initLocale();

      !IS_IOS && await store().dispatch({ type: RESET_EXPOSURES }); // first thing - clear the redux store to fix the android duplications bug

      const notFirstTime = await AsyncStorage.getItem(IS_FIRST_TIME);

      if (notFirstTime === null) {
        return setInitialRoute('Welcome');
      }

      await onBoardingCompletedActions();
    } catch (error) {
      setInitialRoute('Welcome');
      onError({ error });
    }
  };

  const onBoardingCompletedActions = async () => {
    try {
      BackgroundFetch.status(async (status) => {
        if (status !== BackgroundFetch.STATUS_AVAILABLE) {
          await scheduleTask();
        }
      });

      const state: State = await BackgroundGeolocation.getState();

      if (!state.enabled) {
        await startSampling(locale, notificationData);
      } else {
        if (!IS_IOS && !state.enableHeadless) {
          await BackgroundGeolocation.setConfig({
            enableHeadless: true,
            foregroundService: true
          });
        }

        if (state.maxDaysToPersist === 1) {
          await BackgroundGeolocation.setConfig({
            persistMode: BackgroundGeolocation.PERSIST_MODE_LOCATION,
            maxRecordsToPersist: -1,
            maxDaysToPersist: 10000000
          });
        }
      }

      await initBLETracing();
      
      await purgeSamplesDB();
      await clusterLocationsOnAppUpdate();
      // await startForegroundTimer();

      const validExposure = await AsyncStorage.getItem(VALID_EXPOSURE);

      if (validExposure) {
        const { exposure, timestamp }: ValidExposure = JSON.parse(validExposure);

        if (moment().diff(moment(timestamp), 'days') < 14) {
          store().dispatch({ type: SET_VALID_EXPOSURE, payload: { validExposure: exposure } });
        } else {
          await AsyncStorage.removeItem(VALID_EXPOSURE);
        }
      }

      const dbSick = new IntersectionSickDatabase();
      // update all dismissed exposures to have wasThere property
      const dbSickWasUpdated = await AsyncStorage.getItem(SICK_DB_UPDATED);


      if (dbSickWasUpdated !== 'true') {
        const dismissedExposures = await AsyncStorage.getItem(DISMISSED_EXPOSURES);
        if (dismissedExposures) {
          await dbSick.upgradeSickRecord(JSON.parse(dismissedExposures));
        }
        await AsyncStorage.setItem(SICK_DB_UPDATED, 'true');
      }
      // remove intersections older then 2 weeks
      await dbSick.purgeIntersectionSickTable(moment().subtract(2, 'week').unix() * 1000);
      // await dbSick.deleteAll()
      const exposures = await dbSick.listAllRecords();
      
      await store().dispatch(setExposures(exposures.map((exposure: any) => ({ properties: { ...exposure } }))));

      const firstPointTS = JSON.parse(await AsyncStorage.getItem(FIRST_POINT_TS) || 'false');
      firstPointTS && store().dispatch({ type: UPDATE_FIRST_POINT, payload: firstPointTS });

      setInitialRoute('Home');
    } catch (error) {
      setInitialRoute('Home');
      onError({ error });
    }
  };

  const onSeeTerms = () => {
    store().dispatch({ type: HIDE_FORCE_TERMS });
    shouldShowForceTerms.current = true;
    setTimeout(() => toggleWebview(true, USAGE_ON_BOARDING), 300);
  };

  const onApprovedTerms = async () => {
    store().dispatch({ type: HIDE_FORCE_TERMS });
    await AsyncStorage.setItem(CURRENT_TERMS_VERSION, JSON.stringify(termsVersion));
    checkForceUpdate();
  };

  const Stack = createStackNavigator();

  return (
    (!isInitLocale || !initialRoute) ? null : (
      <View style={styles.container}>
        <Stack.Navigator mode="modal" headerMode="none" initialRouteName={initialRoute}>
          <Stack.Screen name="onBoarding" component={OnboardingRoutes} options={{ cardStyleInterpolator: CardStyleInterpolators.forScaleFromCenterAndroid }} />
          <Stack.Screen name="Home" component={Home} options={{ cardStyleInterpolator: CardStyleInterpolators.forScaleFromCenterAndroid }} initialParams={{ isRTL }} />
        </Stack.Navigator>

        <Loader isVisible={showLoader} />
        <ChangeLanguage isVisible={showChangeLanguage} />
        <GeneralWebview isVisible={showWebview} locale={locale} externalUrls={externalUrls} closeWebview={() => toggleWebview(false, '')} usageType={usageType} />
        <ForceUpdate isVisible={showForceUpdate} shouldForce={shouldForce} strings={strings} />
        <ForceTerms isVisible={showForceTerms} isRTL={isRTL} strings={strings} onSeeTerms={onSeeTerms} onApprovedTerms={onApprovedTerms} />
      </View>
    )
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1
  }
});

const mapStateToProps = (state: any) => {
  const {
    general: { showLoader, showWebview, showForceUpdate, shouldForce, usageType, showForceTerms, termsVersion },
    locale: { isInitLocale, showChangeLanguage, strings, locale, isRTL, externalUrls, notificationData }
  } = state;

  return { strings, showLoader, isInitLocale, showChangeLanguage, showWebview, locale, showForceUpdate, shouldForce, usageType, showForceTerms, isRTL, termsVersion, externalUrls, notificationData };
};

export default connect(mapStateToProps, {
  initLocale,
  toggleWebview,
  checkForceUpdate
})(Loading);
